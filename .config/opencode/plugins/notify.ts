import { Plugin } from "@opencode/plugin"

// Commit guard (ported from ~/.claude/hooks/validate-commit-message.sh): block
// any `git commit` whose message contains a Co-Authored-By footer. Throwing in
// execute.before aborts the tool call, mirroring the hook's exit 2.

export default Plugin.define({
  id: "notify",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "shell") return
      const input = event.input as { command?: unknown } | undefined
      const cmd = String(input?.command ?? "")
      if (/\bgit\b.*\bcommit\b/.test(cmd) && cmd.includes("Co-Authored-By")) {
        throw new Error(
          "Commit message contains a Co-Authored-By footer. " +
            "Use the commit-message skill to draft the message instead.",
        )
      }
    })
  },
})
