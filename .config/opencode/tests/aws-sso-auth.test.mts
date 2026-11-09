import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createEnsurer, type Deps } from "../plugins/aws-sso-auth.ts"

const MIN = 60_000

async function setup(opts: { valid?: boolean; loginFails?: boolean; loginMs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "aws-sso-auth-"))
  const state = { valid: opts.valid ?? false, logins: 0, now: 1_000_000, alive: new Set<number>() }
  const run: Deps["run"] = async (cmd, args) => {
    if (cmd !== "aws") throw Object.assign(new Error("not found"), { code: "ENOENT" })
    if (args[0] === "configure" && args[1] === "export-credentials") {
      if (!state.valid) throw new Error("expired")
      return { stdout: "{}" }
    }
    if (args[0] === "configure" && args[1] === "get") return { stdout: "Bedrock\n" }
    if (args[0] === "sso" && args[1] === "login") {
      state.logins++
      await new Promise((r) => setTimeout(r, opts.loginMs ?? 20))
      if (opts.loginFails) throw new Error("canceled")
      state.valid = true
      return { stdout: "" }
    }
    throw new Error(`unexpected ${args.join(" ")}`)
  }
  const deps = (pid = 100): Deps => ({
    run,
    dir,
    env: { AWS_PROFILE: "p" },
    pid,
    now: () => state.now,
    isAlive: (p) => p === pid || state.alive.has(p),
    log: () => {},
  })
  return { dir, state, deps }
}

test("does nothing when credentials are already valid", async () => {
  const t = await setup({ valid: true })
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 0)
})

test("concurrent instances start only one login", async () => {
  const t = await setup()
  for (const pid of [1, 2, 3]) t.state.alive.add(pid)
  await Promise.all([createEnsurer(t.deps(1)), createEnsurer(t.deps(2)), createEnsurer(t.deps(3))].map((e) => e()))
  assert.equal(t.state.logins, 1)
  assert.deepEqual(
    (await readdir(t.dir)).filter((f) => f.endsWith(".lock")),
    [],
  )
})

test("re-checks credentials after taking the lock", async () => {
  const t = await setup()
  let checks = 0
  const deps = t.deps()
  const run = deps.run
  deps.run = async (cmd, args, o) => {
    if (args[1] === "export-credentials" && ++checks === 2) t.state.valid = true
    return run(cmd, args, o)
  }
  await createEnsurer(deps)()
  assert.equal(t.state.logins, 0)
})

test("a failed login blocks retries until the cooldown passes", async () => {
  const t = await setup({ loginFails: true })
  await createEnsurer(t.deps())()
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 1)
  t.state.now += 29 * MIN
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 1)
  t.state.now += 2 * MIN
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 2)
})

test("skips login while a live process holds the lock", async () => {
  const t = await setup()
  await createEnsurer(t.deps())() // creates the directory and finishes a login
  t.state.valid = false
  t.state.logins = 0
  const lock = (await readdir(t.dir)).length
  assert.equal(lock, 0)
  t.state.alive.add(999)
  const key = await keyFile(t)
  await writeFile(key, JSON.stringify({ pid: 999, startedAt: t.state.now, token: "x" }))
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 0)
})

test("recovers a lock left by a dead process", async () => {
  const t = await setup()
  await createEnsurer(t.deps())()
  t.state.valid = false
  t.state.logins = 0
  const key = await keyFile(t)
  await writeFile(key, JSON.stringify({ pid: 999, startedAt: t.state.now, token: "x" }))
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 1)
})

test("recovers a lock older than the login timeout", async () => {
  const t = await setup()
  await createEnsurer(t.deps())()
  t.state.valid = false
  t.state.logins = 0
  t.state.alive.add(999)
  const key = await keyFile(t)
  await writeFile(key, JSON.stringify({ pid: 999, startedAt: t.state.now - 6 * MIN, token: "x" }))
  await createEnsurer(t.deps())()
  assert.equal(t.state.logins, 1)
})

test("missing aws CLI is ignored", async () => {
  const t = await setup()
  const deps = t.deps()
  deps.run = async () => {
    throw Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" })
  }
  await createEnsurer(deps)()
  assert.equal(t.state.logins, 0)
})

// The lock path is derived from a hash, so learn it by observing a login in flight.
async function keyFile(t: Awaited<ReturnType<typeof setup>>) {
  let found = ""
  const deps = t.deps(4242)
  const run = deps.run
  deps.run = async (cmd, args, o) => {
    if (args[0] === "sso") {
      found = (await readdir(t.dir)).find((f) => f.endsWith(".lock")) ?? ""
    }
    return run(cmd, args, o)
  }
  const valid = t.state.valid
  const logins = t.state.logins
  t.state.valid = false
  await createEnsurer(deps)()
  t.state.valid = valid
  t.state.logins = logins
  return path.join(t.dir, found)
}
