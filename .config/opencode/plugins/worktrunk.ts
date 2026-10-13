// Worktrunk activity tracking plugin for OpenCode.
//
// Tracks OpenCode session activity per branch, showing status markers in `wt list`:
//   🤖 — agent is working
//   💬 — agent is waiting for input

import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"

const WORKING = "🤖"
const WAITING = "💬"

function wt(directory: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile("wt", ["config", "state", "marker", ...args], { cwd: directory, timeout: 5_000 }, () => resolve())
  })
}

export default Plugin.define({
  id: "worktrunk",
  setup(ctx) {
    const controller = new AbortController()
    const directory = ctx.location.directory
    // Execution events carry no location, and session.deleted arrives after the
    // session can no longer be looked up, so remember where each session lives.
    const sessionDirectories = new Map<string, string>()

    async function directoryOf(sessionID: string): Promise<string | undefined> {
      const known = sessionDirectories.get(sessionID)
      if (known) return known
      try {
        const session = await ctx.session.get({ sessionID })
        sessionDirectories.set(sessionID, session.location.directory)
        return session.location.directory
      } catch {
        return undefined
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // The stream is server-wide and every location loads its own instance of this
          // plugin, so only react to this location's sessions.
          switch (event.type) {
            case "session.execution.started":
              if ((await directoryOf(event.data.sessionID)) === directory) await wt(directory, ["set", WORKING])
              break
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
              if ((await directoryOf(event.data.sessionID)) === directory) await wt(directory, ["set", WAITING])
              break
            case "session.moved":
              sessionDirectories.delete(event.data.sessionID)
              break
            case "session.deleted": {
              const owner = sessionDirectories.get(event.data.sessionID)
              sessionDirectories.delete(event.data.sessionID)
              if (owner === directory) await wt(directory, ["clear"])
              break
            }
          }
        }
      } catch {
        // Aborted on unload, or the stream dropped; markers are best-effort.
      }
    })()

    return () => controller.abort()
  },
})
