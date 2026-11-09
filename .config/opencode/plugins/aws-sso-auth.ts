import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

/**
 * Ensures an AWS SSO session is active before OpenCode starts using the
 * built-in amazon-bedrock provider. That provider reads credentials via the
 * standard AWS credential chain and refreshes short-lived credentials on its
 * own, but it has no way to run `aws sso login` when the underlying SSO
 * session itself has expired.
 *
 * Plugin reloads and concurrent OpenCode processes each get their own module
 * state, so de-duplication lives on disk: one login per SSO session at a
 * time, and a cooldown after a failed or abandoned login so a broken session
 * can't open a browser tab on every check. `aws sso login` itself is left
 * untouched, so AWS still opens the browser and prints the URL.
 */

const CHECK_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const LOCK_STALE_MS = LOGIN_TIMEOUT_MS + 30_000
const COOLDOWN_MS = 30 * 60_000
// Lapsed SSO sessions are noticed by re-checking now and then, not only at load.
const RECHECK_MS = 30 * 60_000

type Run = (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout?: unknown } | unknown>

export interface Deps {
  run: Run
  dir: string
  env: NodeJS.ProcessEnv
  pid: number
  now: () => number
  isAlive: (pid: number) => boolean
  log: (msg: string) => void
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function defaultDeps(): Deps {
  const state = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state")
  return {
    run: promisify(execFile) as Run,
    dir: path.join(state, "opencode", "aws-sso-auth"),
    env: process.env,
    pid: process.pid,
    now: Date.now,
    isAlive,
    log: (msg) => console.error(`[aws-sso-auth] ${msg}`),
  }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code

async function hasValidCredentials(deps: Deps, profileArgs: string[]): Promise<boolean> {
  try {
    await deps.run("aws", ["configure", "export-credentials", ...profileArgs], { timeout: CHECK_TIMEOUT_MS })
    return true
  } catch (err) {
    if (code(err) === "ENOENT") throw err
    return false
  }
}

async function sessionKey(deps: Deps, profileArgs: string[]): Promise<string> {
  let session = ""
  try {
    const out = (await deps.run("aws", ["configure", "get", "sso_session", ...profileArgs], {
      timeout: CHECK_TIMEOUT_MS,
    })) as { stdout?: unknown }
    session = String(out?.stdout ?? "").trim()
  } catch {}
  const id = [deps.env.AWS_CONFIG_FILE ?? "~/.aws/config", session || deps.env.AWS_PROFILE || "default"].join("\0")
  return createHash("sha256").update(id).digest("hex").slice(0, 16)
}

async function inCooldown(deps: Deps, file: string): Promise<boolean> {
  try {
    const failedAt = Number(await readFile(file, "utf8"))
    return Number.isFinite(failedAt) && deps.now() - failedAt < COOLDOWN_MS
  } catch {
    return false
  }
}

async function isStale(deps: Deps, file: string, raw: string): Promise<boolean> {
  try {
    const held = JSON.parse(raw) as { pid: number; startedAt: number }
    return !deps.isAlive(held.pid) || deps.now() - held.startedAt > LOCK_STALE_MS
  } catch {
    // A holder may be mid-write; only an old unreadable file is abandoned.
    const info = await stat(file).catch(() => undefined)
    return !!info && deps.now() - info.mtimeMs > LOCK_STALE_MS
  }
}

// Move the stale file aside before deleting so a lock created by someone else
// in the meantime is never removed; put it back if that happened.
async function reclaimIfStale(deps: Deps, file: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(file, "utf8")
  } catch (err) {
    return code(err) === "ENOENT"
  }
  if (!(await isStale(deps, file, raw))) return false
  const aside = `${file}.${randomUUID()}.stale`
  try {
    await rename(file, aside)
  } catch (err) {
    return code(err) === "ENOENT"
  }
  const moved = await readFile(aside, "utf8").catch(() => undefined)
  if (moved !== raw) await link(aside, file).catch(() => {})
  await rm(aside, { force: true })
  return moved === raw
}

async function acquireLock(deps: Deps, file: string): Promise<(() => Promise<void>) | undefined> {
  const token = randomUUID()
  const body = JSON.stringify({ pid: deps.pid, startedAt: deps.now(), token })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, body, { flag: "wx" })
      return async () => {
        const current = await readFile(file, "utf8").catch(() => "")
        if (current === body) await rm(file, { force: true })
      }
    } catch (err) {
      if (code(err) !== "EEXIST") throw err
      if (!(await reclaimIfStale(deps, file))) return undefined
    }
  }
  return undefined
}

export function createEnsurer(deps: Deps) {
  async function ensureSession() {
    const profile = deps.env.AWS_PROFILE
    const profileArgs = profile ? ["--profile", profile] : []
    try {
      if (await hasValidCredentials(deps, profileArgs)) return
      await mkdir(deps.dir, { recursive: true })
      const key = path.join(deps.dir, await sessionKey(deps, profileArgs))
      const cooldown = `${key}.cooldown`
      if (await inCooldown(deps, cooldown)) return

      const release = await acquireLock(deps, `${key}.lock`)
      if (!release) return
      try {
        // Another instance may have finished (or failed) while we waited on the lock.
        if (await hasValidCredentials(deps, profileArgs)) return
        if (await inCooldown(deps, cooldown)) return
        try {
          await deps.run("aws", ["sso", "login", ...profileArgs], { timeout: LOGIN_TIMEOUT_MS })
        } catch (err) {
          if (code(err) === "ENOENT") throw err
          await writeFile(cooldown, String(deps.now()))
          deps.log(`sso login failed: ${err}`)
          return
        }
        if (!(await hasValidCredentials(deps, profileArgs))) await writeFile(cooldown, String(deps.now()))
      } finally {
        await release()
      }
    } catch (err) {
      if (code(err) === "ENOENT") return
      deps.log(`sso check failed: ${err}`)
    }
  }

  let ensured: Promise<void> | undefined
  return function ensureOnce() {
    ensured ??= ensureSession().finally(() => {
      ensured = undefined
    })
    return ensured
  }
}

export default Plugin.define({
  id: "aws-sso-auth",
  setup() {
    const ensureOnce = createEnsurer(defaultDeps())
    // Login can wait minutes on a browser, so it must not hold plugin
    // activation (and with it every other plugin's readiness) hostage.
    void ensureOnce()
    const timer = setInterval(() => void ensureOnce(), RECHECK_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  },
})
