import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Thin OpenCode adapter over the agent-agnostic context-checkpoint skill in
// the `ex` plugin (shared with Claude Code and Codex). All GitLab/snippet
// logic — ticket-only gating, read/write token handling, merge-safety
// (compare-and-swap on save), secret-pattern guard — lives in:
//   ~/.agents/plugins/ex/skills/context-checkpoint/run.sh
//   ~/.agents/plugins/ex/lib/checkpoint.sh
// This file only adds OpenCode-specific plumbing: tool registration, the
// hard ctx.ask() confirmation gate before every write, a first-message
// "checkpoint available" reminder (mirrors the Claude/Codex SessionStart
// hook), and a Plan-mode-exit reminder. See that skill's SKILL.md for the
// shared behavior contract — in particular, saving over an existing
// checkpoint requires passing its updated_at back as expectedUpdatedAt.

const RUN_SH = `${process.env.HOME}/.agents/plugins/ex/skills/context-checkpoint/run.sh`

export default (async ({ $ }) => {
  // run.sh writes its "ERROR: ..." messages to stderr and its success output
  // (CREATED/UPDATED/UNCHANGED/FOUND/NONE/ticket value) to stdout. Capture
  // both explicitly and pick the right one by exit code — Bun's `$` with
  // `.text()` alone would only ever see stdout, silently dropping errors.
  const run = async (args: string[]): Promise<string> => {
    const result = await $`${RUN_SH} ${args}`.quiet().nothrow()
    const stdout = result.stdout.toString().trim()
    const stderr = result.stderr.toString().trim()
    if (result.exitCode !== 0) {
      return stderr || stdout || `ERROR: run.sh ${args.join(" ")} exited ${result.exitCode}`
    }
    return stdout
  }

  const lastAgent = new Map<string, string>()
  const seenSessions = new Set<string>()

  return {
    tool: {
      gitlab_checkpoint_save: tool({
        description:
          "Save or update the context checkpoint for the current ticket ($TICKET_ID) to a private personal " +
          "GitLab snippet, via the shared ex context-checkpoint skill. Use to preserve the plan, key " +
          "decisions, findings, progress, blockers, and next steps for a later /resume — possibly from a " +
          "different machine or after context is lost/compacted. Always asks the user to confirm before " +
          "writing. Unavailable outside a ticket worktree (no TICKET_ID). If a checkpoint already exists, " +
          "you must call gitlab_checkpoint_resume first, merge its content with what's new, and pass its " +
          "updatedAt back here — this tool refuses to blindly overwrite.",
        args: {
          title: tool.schema.string().describe("Short human title, e.g. the ticket summary or task name."),
          body: tool.schema
            .string()
            .describe(
              "Markdown body with clear section headers: Goal, Decisions, Findings, Plan, Progress, Blockers, " +
                "Next steps. Should be a merge of any existing checkpoint plus what's new — never a regression.",
            ),
          expectedUpdatedAt: tool.schema
            .string()
            .optional()
            .describe(
              "The updated_at of the existing checkpoint, from gitlab_checkpoint_resume. Required if a " +
                "checkpoint already exists; omit only when creating the first checkpoint for this ticket.",
            ),
        },
        async execute(args, ctx) {
          try {
            await ctx.ask({
              permission: "gitlab_checkpoint_save",
              patterns: [],
              always: [],
              metadata: { title: args.title },
            })
          } catch {
            return { title: "Checkpoint not saved", output: "User did not approve the GitLab snippet write." }
          }

          const bodyPath = join(
            tmpdir(),
            `opencode-gitlab-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
          )
          writeFileSync(bodyPath, args.body, { mode: 0o600 })
          try {
            const saveArgs = ["save", args.title, bodyPath]
            if (args.expectedUpdatedAt) saveArgs.push(args.expectedUpdatedAt)
            const result = await run(saveArgs)
            if (result.startsWith("ERROR")) {
              return { title: "Checkpoint not saved", output: result }
            }
            return { title: "Checkpoint saved", output: result.trim() }
          } finally {
            unlinkSync(bodyPath)
          }
        },
      }),

      gitlab_checkpoint_resume: tool({
        description:
          "Read-only. Check for and load the context checkpoint for the current ticket ($TICKET_ID), via the " +
          "shared ex context-checkpoint skill. Never writes anything, so it does not require confirmation. " +
          "Unavailable outside a ticket worktree (no TICKET_ID). Also use this before " +
          "gitlab_checkpoint_save to get the updatedAt needed to update an existing checkpoint.",
        args: {},
        async execute() {
          const hasResult = await run(["has"])
          if (hasResult.startsWith("ERROR")) {
            return { title: "Not available", output: hasResult }
          }
          if (!hasResult.startsWith("FOUND")) {
            return { title: "No checkpoint found", output: "No checkpoint found for the current ticket." }
          }

          const [, id, updatedAt, url] = hasResult.trim().split("\t")
          const content = await run(["read"])
          if (content.startsWith("ERROR")) {
            return { title: "No checkpoint found", output: content }
          }
          return {
            title: "Checkpoint found",
            output: content,
            metadata: { id, updatedAt, url },
          }
        },
      }),
    },

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return

      // Startup check: on the first message of a new session, if TICKET_ID
      // is set and a checkpoint exists for it, remind the agent to ask
      // before resuming. Mirrors the Claude/Codex SessionStart hook — never
      // loads content automatically.
      if (!seenSessions.has(sessionID)) {
        seenSessions.add(sessionID)
        if (process.env.TICKET_ID) {
          try {
            const result = await run(["has"])
            if (result.startsWith("FOUND")) {
              const [, , updatedAt, url] = result.trim().split("\t")
              output.parts.push(
                {
                  id: crypto.randomUUID(),
                  sessionID,
                  messageID: output.message.id,
                  type: "text",
                  text:
                    `[checkpoint available: a saved context checkpoint exists for ${process.env.TICKET_ID} ` +
                    `(last updated ${updatedAt}${url ? `, ${url}` : ""}). Ask the user whether to resume it ` +
                    "(e.g. via /resume) before proceeding. Do not load or summarize its content until they " +
                    "confirm.]",
                } as any,
              )
            }
          } catch {
            // best-effort; never block the first message on a lookup failure
          }
        }
      }

      // Plan-exit reminder.
      const prevAgent = lastAgent.get(sessionID)
      const currentAgent = input.agent
      if (prevAgent === "plan" && currentAgent && currentAgent !== "plan") {
        output.parts.push(
          {
            id: crypto.randomUUID(),
            sessionID,
            messageID: output.message.id,
            type: "text",
            text:
              "[checkpoint reminder: you just left Plan mode — consider running /checkpoint to save the " +
              "approved plan to a GitLab snippet before continuing, in case context is lost or compacted later]",
          } as any,
        )
      }
      if (currentAgent) lastAgent.set(sessionID, currentAgent)
    },
  }
}) satisfies Plugin
