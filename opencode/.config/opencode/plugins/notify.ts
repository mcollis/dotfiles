import type { Plugin } from "@opencode-ai/plugin"

// Ports two Claude Code hooks into OpenCode:
//
// 1. Commit guard (was ~/.claude/hooks/validate-commit-message.sh): block any
//    `git commit` whose message contains a Co-Authored-By footer. Throwing in
//    tool.execute.before aborts the tool call, mirroring the hook's exit 2.
//
// 2. tmux notifications (was the Notification/Stop/UserPromptSubmit/SessionEnd
//    hooks calling ~/.tmux-themes/claude-notify.sh): set "waiting" when the
//    agent needs the user (permission prompt), clear it when work resumes or
//    the session goes idle.
//
// Nothing here is Claude-specific; the notify script path is reused as-is.

const NOTIFY = `${process.env.HOME}/.tmux-themes/claude-notify.sh`

export const NotifyPlugin: Plugin = async ({ $ }) => {
  const notify = async (state: "waiting" | "clear") => {
    try {
      await $`${NOTIFY} ${state}`.quiet()
    } catch {
      // best-effort; never let notification failures break a session
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const cmd = String(output.args?.command ?? "")
      if (/\bgit\b.*\bcommit\b/.test(cmd) && cmd.includes("Co-Authored-By")) {
        throw new Error(
          "Commit message contains a Co-Authored-By footer. " +
            "Use the commit-message skill to draft the message instead.",
        )
      }
    },

    event: async ({ event }) => {
      switch (event.type) {
        case "permission.asked":
          await notify("waiting")
          break
        case "session.idle":
        case "permission.replied":
          await notify("clear")
          break
      }
    },
  }
}
