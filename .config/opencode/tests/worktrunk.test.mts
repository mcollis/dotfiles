import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../plugins/worktrunk.ts"

// A real directory: the plugin runs `wt` with it as the working directory.
const DIR = mkdtempSync(join(tmpdir(), "worktrunk-location-"))

// Puts a fake `wt` first on PATH that appends its arguments to a log file.
function fakeWt() {
  const dir = mkdtempSync(join(tmpdir(), "worktrunk-test-"))
  const log = join(dir, "calls.log")
  const bin = join(dir, "wt")
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\n`)
  chmodSync(bin, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous}`
  const calls = () => {
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.replace("config state marker ", ""))
    } catch {
      return []
    }
  }
  return {
    calls,
    restore() {
      process.env.PATH = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function load(sessions: Record<string, string>) {
  const queue: any[] = []
  let waiter: (() => void) | undefined
  let aborted = false
  const ctx: any = {
    location: { directory: DIR },
    session: { get: async ({ sessionID }: any) => ({ location: { directory: sessions[sessionID] ?? DIR } }) },
    event: {
      subscribe: ({ signal }: any) =>
        (async function* () {
          signal.addEventListener("abort", () => {
            aborted = true
            waiter?.()
          })
          while (!aborted) {
            if (queue.length === 0) await new Promise<void>((resolve) => (waiter = resolve))
            const next = queue.shift()
            if (next) yield next
          }
        })(),
    },
  }
  const cleanup: any = await plugin.setup(ctx)
  const emit = async (type: string, sessionID: string) => {
    queue.push({ type, data: { sessionID } })
    waiter?.()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return { emit, cleanup }
}

test("one agent finishing does not mark the worktree waiting while another still works", async () => {
  const wt = fakeWt()
  try {
    const { emit, cleanup } = await load({})
    await emit("session.execution.started", "a")
    await emit("session.execution.started", "b")
    await emit("session.execution.succeeded", "a")
    assert.equal(wt.calls().at(-1), "set 🤖", "b is still working")
    await emit("session.execution.succeeded", "b")
    assert.equal(wt.calls().at(-1), "set 💬")
    cleanup()
  } finally {
    wt.restore()
  }
})

test("a session moved out of the worktree stops counting as working", async () => {
  const wt = fakeWt()
  try {
    const { emit, cleanup } = await load({})
    await emit("session.execution.started", "a")
    await emit("session.moved", "a")
    assert.equal(wt.calls().at(-1), "set 💬")
    cleanup()
  } finally {
    wt.restore()
  }
})

test("deleting the last session clears the marker, but not while another session is here", async () => {
  const wt = fakeWt()
  try {
    const { emit, cleanup } = await load({})
    await emit("session.execution.started", "a")
    await emit("session.execution.succeeded", "a")
    await emit("session.execution.started", "b")
    await emit("session.execution.succeeded", "b")
    await emit("session.deleted", "a")
    assert.notEqual(wt.calls().at(-1), "clear", "b still lives here")
    await emit("session.deleted", "b")
    assert.equal(wt.calls().at(-1), "clear")
    cleanup()
  } finally {
    wt.restore()
  }
})

test("sessions in other worktrees never touch this worktree's marker", async () => {
  const wt = fakeWt()
  try {
    const { emit, cleanup } = await load({ other: "/work/elsewhere" })
    await emit("session.execution.started", "other")
    assert.deepEqual(wt.calls(), [])
    cleanup()
  } finally {
    wt.restore()
  }
})
