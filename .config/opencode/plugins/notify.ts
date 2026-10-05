import type { Plugin } from "@opencode-ai/plugin"

// Commit guard (ported from ~/.claude/hooks/validate-commit-message.sh): block
// any `git commit` whose message contains a Co-Authored-By footer. Throwing in
// tool.execute.before aborts the tool call, mirroring the hook's exit 2.

export const NotifyPlugin: Plugin = async () => {
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
  }
}
