import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { pathToFileURL } from "node:url"

// Generic bootstrap for OpenCode integrations shipped inside the `ex`
// plugin submodule (shared with Claude Code/Codex — see
// ~/.agents/plugins/ex). This file is intentionally tiny and knows
// nothing about what `ex` actually does: it just imports `tool` from the
// package already installed here, hands it to `ex`'s OpenCode entry
// point, and returns whatever Hooks that produces. Adding, removing, or
// changing an `ex` OpenCode integration (context-checkpoint today,
// possibly others later) should never require touching dotfiles again —
// only ~/.agents/plugins/ex/integrations/opencode/.
const ENTRY = `${process.env.HOME}/.agents/plugins/ex/integrations/opencode/index.ts`

export default (async (ctx, options) => {
  if (!existsSync(ENTRY)) {
    await ctx.client.app
      .log({
        body: {
          service: "ex-loader",
          level: "warn",
          message:
            `ex OpenCode integration not found at ${ENTRY} — is the ex submodule checked out? ` +
            "(git submodule update --init --recursive, then stow agents)",
        },
      })
      .catch(() => {})
    return {}
  }

  const mod = await import(pathToFileURL(ENTRY).href)
  const createPlugin = mod.default
  if (typeof createPlugin !== "function") return {}

  const plugin = createPlugin({ tool })
  return plugin(ctx, options)
}) satisfies Plugin
