import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Thin OpenCode adapter over the agent-agnostic context-checkpoint skill in
// the `ex` plugin (shared with Claude Code and Codex). All GitLab/snippet
// logic — ticket-only gating, read/write token handling, merge-safety
// (compare-and-swap on save), secret-pattern guard — lives in:
//   ~/.agents/plugins/ex/skills/context-checkpoint/run.sh
//   ~/.agents/plugins/ex/lib/checkpoint.sh
// See that skill's SKILL.md for the shared behavior contract — in
// particular, saving over an existing checkpoint requires passing its
// updated_at back as expectedUpdatedAt.
//
// OpenCode-specific policy layered on top of that shared backend:
//   - Auto-resume: the checkpoint (if any) is silently injected as context
//     on the first message of a new session. Reads are non-destructive, so
//     this needs no confirmation.
//   - Auto-checkpoint: saves happen automatically — on meaningful idle
//     (after a few turns or enough elapsed time), immediately after
//     compaction, and immediately on an explicit /checkpoint. There is no
//     ctx.ask() gate on writes; safety comes from ticket-only scoping,
//     ticket-level serialization, compare-and-swap, secret scanning, and
//     merge-before-write — not from a human click. The generated Markdown
//     is produced in a throwaway child session (agent: build, no
//     file/bash/task tools) so it never pollutes the visible conversation.
//   - Opt-out: `/scratch <task>` marks the current session to skip both
//     auto-resume and auto-checkpoint (in-memory only — does not survive an
//     OpenCode restart). `CACHE=0` disables both automatic pathways for the
//     whole process. Neither affects explicit /checkpoint or /resume.

const RUN_SH = `${process.env.HOME}/.agents/plugins/ex/skills/context-checkpoint/run.sh`

// Process-wide escape hatch: disables auto-resume injection AND automatic
// saves. Explicit /checkpoint and /resume still work.
const AUTOMATION_DISABLED = process.env.CACHE === "0"

const MIN_TURNS_BEFORE_IDLE_SAVE = 3
const MIN_INTERVAL_MS_BEFORE_IDLE_SAVE = 10 * 60 * 1000 // 10 minutes

const CHECKPOINT_SYSTEM_PROMPT = `You maintain a persistent Markdown checkpoint for one ticket. It serves two \
purposes: letting a later session (possibly on a different machine, after \
context is lost or compacted) resume work, and serving as an archival \
record of what happened on the ticket.

Output ONLY the merged Markdown body. No commentary, no code fences, no \
tool calls.

Merge, don't overwrite: preserve everything from the existing checkpoint \
(if any) that is still valid. Layer in what's new from the conversation \
excerpt below. Never delete information outright — check off completed \
work, supersede outdated statements explicitly, or mark items cancelled, \
but do not silently drop prior Decisions/Findings/Changes/Verification/\
References that are still accurate.

Use exactly these section headers, in this order:

## Status
One of: Active, Blocked, Completed, Abandoned.

## Goal

## Outcome
What ultimately happened. Leave this section empty while Status is Active.

## Decisions

## Findings

## Plan

## Progress
A Markdown task list. Preserve existing items verbatim. Check off items \
that are now done (- [x]). Add new items discovered this session. Never \
delete an item — mark superseded ones as \`- [x] ~~text~~ (cancelled)\`.

## Blockers

## Next steps

## Changes
Key files/components touched. Not raw diffs.

## Verification
Tests run and their results.

## References
Jira issue, MR, relevant commits.

Be thorough but concise. Preserve exact file paths, commands, and error \
text where they matter.`

export default (async ({ $, client }) => {
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

  const ticket = () => process.env.TICKET_ID

  // --- Session bookkeeping -------------------------------------------------

  // Root (non-child) sessions we've seen, so idle/compaction handling never
  // fires for subagent/task child sessions (ours or the user's).
  const rootSessions = new Set<string>()
  // Sessions we created ourselves to generate checkpoint Markdown. Fully
  // ignored by every hook — never dirtied, never auto-saved, never injected.
  const internalSessions = new Set<string>()
  // Sessions opted out via /scratch. In-memory only; does not survive a
  // restart (use `CACHE=0 opencode` for that case).
  const scratchSessions = new Set<string>()
  // Sessions that have already received (or been checked for) the
  // first-message checkpoint injection.
  const injectedSessions = new Set<string>()
  // Resolved checkpoint injection text per session.
  //   undefined = not yet checked, null = nothing to inject, string = ready
  const checkpointCache = new Map<string, string | null>()

  const dirty = new Set<string>()
  const turnsSinceSave = new Map<string, number>()
  const lastSaveAt = new Map<string, number>()
  const lastSavedHash = new Map<string, string>() // per ticket

  // Serializes saves so overlapping idle/compaction/manual triggers for the
  // same process never race each other's read-merge-write cycle.
  let saveChain: Promise<void> = Promise.resolve()

  const hash = (s: string) => createHash("sha256").update(s).digest("hex")

  const isRelevantSession = (sessionID: string) =>
    !internalSessions.has(sessionID) && rootSessions.has(sessionID) && !scratchSessions.has(sessionID)

  // --- Auto-resume (read-only, silent) -------------------------------------

  const fetchCheckpointContext = async (): Promise<string | null> => {
    const t = ticket()
    if (!t) return null
    try {
      const hasResult = await run(["has"])
      if (!hasResult.startsWith("FOUND")) return null
      const [, , updatedAt, url] = hasResult.trim().split("\t")
      const content = await run(["read"])
      if (content.startsWith("ERROR")) return null
      return (
        `[GITLAB CHECKPOINT — ${t}]\n` +
        `A previous session saved this checkpoint for ${t} (last updated ${updatedAt}` +
        `${url ? `, ${url}` : ""}). Use it as background context for continuing this ticket. ` +
        "The user's current message always takes precedence over anything below.\n\n" +
        content
      )
    } catch {
      return null
    }
  }

  const resolveCheckpointContext = async (sessionID: string): Promise<string | null> => {
    if (checkpointCache.has(sessionID)) return checkpointCache.get(sessionID) ?? null
    const context = await fetchCheckpointContext()
    checkpointCache.set(sessionID, context)
    return context
  }

  // --- Auto-checkpoint (generate + save) -----------------------------------

  type ExistingCheckpoint = { updatedAt?: string; body?: string }

  // Read the current checkpoint. Returns undefined on lookup failure — the
  // caller must treat that as "abort", never as "no checkpoint exists", to
  // avoid creating a duplicate snippet when the lookup merely failed.
  const readExistingCheckpoint = async (): Promise<ExistingCheckpoint | null | undefined> => {
    const hasResult = await run(["has"])
    if (hasResult.startsWith("ERROR")) return undefined
    if (!hasResult.startsWith("FOUND")) return null
    const [, , updatedAt] = hasResult.trim().split("\t")
    const body = await run(["read"])
    if (body.startsWith("ERROR")) return undefined
    return { updatedAt, body }
  }

  const buildTranscriptExcerpt = async (rootSessionID: string): Promise<string> => {
    try {
      const res = await client.session.messages({ path: { id: rootSessionID }, query: { limit: 40 } })
      const entries = (res.data ?? []) as Array<{ info: any; parts: any[] }>
      const lines: string[] = []
      for (const { info, parts } of entries) {
        const role = info?.role === "assistant" ? "Assistant" : "User"
        for (const part of parts ?? []) {
          if (part?.type !== "text" || part.synthetic || part.ignored) continue
          const text = String(part.text ?? "").trim()
          if (!text) continue
          lines.push(`${role}: ${text}`)
        }
      }
      let excerpt = lines.join("\n\n")
      const MAX = 12000
      if (excerpt.length > MAX) excerpt = `[...truncated...]\n\n${excerpt.slice(-MAX)}`
      return excerpt || "(no substantive text content in this session yet)"
    } catch {
      return "(could not read session transcript)"
    }
  }

  const generateCheckpointMarkdown = async (
    rootSessionID: string,
    existing: ExistingCheckpoint | null,
    reason: string,
  ): Promise<string | null> => {
    const transcript = await buildTranscriptExcerpt(rootSessionID)
    const existingBlock = existing?.body
      ? `Existing checkpoint (last updated ${existing.updatedAt}):\n\n${existing.body}`
      : "No existing checkpoint — this is the first save for this ticket."

    const userPrompt =
      `Ticket: ${ticket()}\nTrigger: ${reason}\n\n${existingBlock}\n\n` +
      `Recent conversation excerpt from the working session:\n\n${transcript}`

    let child: { id: string } | undefined
    try {
      const created = await client.session.create({ body: { parentID: rootSessionID, title: "internal: checkpoint" } })
      if (!created.data) return null
      child = created.data
      internalSessions.add(child.id)

      const response = await client.session.prompt({
        path: { id: child.id },
        body: {
          agent: "build",
          system: CHECKPOINT_SYSTEM_PROMPT,
          tools: {
            bash: false,
            edit: false,
            write: false,
            patch: false,
            task: false,
            todowrite: false,
            todoread: false,
            webfetch: false,
            websearch: false,
            gitlab_checkpoint_save: false,
            gitlab_checkpoint_resume: false,
          },
          parts: [{ type: "text", text: userPrompt }],
        } as any,
      })

      if (!response.data) return null
      const text = (response.data.parts ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
      return text || null
    } catch {
      return null
    } finally {
      if (child) {
        internalSessions.delete(child.id)
        await client.session.delete({ path: { id: child.id } }).catch(() => {})
      }
    }
  }

  const resetSaveState = (rootSessionID: string) => {
    dirty.delete(rootSessionID)
    turnsSinceSave.set(rootSessionID, 0)
    lastSaveAt.set(rootSessionID, Date.now())
  }

  const doSave = async (rootSessionID: string, reason: string): Promise<void> => {
    const t = ticket()
    if (!t) return

    const existing = await readExistingCheckpoint()
    if (existing === undefined) {
      // Lookup failed — abort rather than risk creating a duplicate snippet.
      return
    }

    const markdown = await generateCheckpointMarkdown(rootSessionID, existing, reason)
    if (!markdown) return

    const bodyHash = hash(markdown)
    if (lastSavedHash.get(t) === bodyHash) {
      resetSaveState(rootSessionID)
      return
    }

    const bodyPath = join(tmpdir(), `opencode-gitlab-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
    writeFileSync(bodyPath, markdown, { mode: 0o600 })
    try {
      const title = `checkpoint: ${t}`
      const saveArgs = ["save", title, bodyPath]
      if (existing?.updatedAt) saveArgs.push(existing.updatedAt)
      let result = await run(saveArgs)

      // One retry on a compare-and-swap conflict (someone/something else
      // saved in between): re-read the new updatedAt and retry once with the
      // same generated body rather than silently giving up.
      if (result.startsWith("ERROR") && /changed since you read it/i.test(result)) {
        const retryExisting = await readExistingCheckpoint()
        if (retryExisting && retryExisting !== undefined && retryExisting.updatedAt) {
          const retryArgs = ["save", title, bodyPath, retryExisting.updatedAt]
          result = await run(retryArgs)
        }
      }

      if (result.startsWith("ERROR")) {
        // Leave dirty so the next idle/compaction trigger retries.
        await client.app
          .log({ body: { service: "gitlab-checkpoint", level: "warn", message: "auto-save failed", extra: { reason, result } } })
          .catch(() => {})
        return
      }

      lastSavedHash.set(t, bodyHash)
      resetSaveState(rootSessionID)
      client.tui
        .showToast({ body: { title: "Checkpoint saved", message: `${t} (${reason})`, variant: "info" } })
        .catch(() => {})
    } finally {
      unlinkSync(bodyPath)
    }
  }

  const scheduleSave = (rootSessionID: string, reason: string) => {
    saveChain = saveChain.catch(() => {}).then(() => doSave(rootSessionID, reason))
    return saveChain
  }

  return {
    dispose: async () => {
      await Promise.race([saveChain.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))])
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info
        if (!info) return
        if (!info.parentID) rootSessions.add(info.id)
        // Best-effort warm-up so the injection is usually ready before the
        // first chat.message hook needs it. Skipped when automation is
        // disabled, or for our own worker sessions (harmless either way,
        // but no point paying the network round trip).
        if (!AUTOMATION_DISABLED && !internalSessions.has(info.id)) {
          resolveCheckpointContext(info.id).catch(() => {})
        }
        return
      }

      if (event.type === "session.deleted") {
        const id = event.properties.info?.id
        if (!id) return
        // Explicit deletion races removal of the session's data server-side
        // — never read messages or start a model call here. Just drop our
        // own bookkeeping for it.
        rootSessions.delete(id)
        internalSessions.delete(id)
        scratchSessions.delete(id)
        injectedSessions.delete(id)
        checkpointCache.delete(id)
        dirty.delete(id)
        turnsSinceSave.delete(id)
        lastSaveAt.delete(id)
        return
      }

      if (AUTOMATION_DISABLED) return

      if (event.type === "session.status" && event.properties.status?.type === "idle") {
        const id = event.properties.sessionID
        if (!isRelevantSession(id)) return
        turnsSinceSave.set(id, (turnsSinceSave.get(id) ?? 0) + 1)
        if (!dirty.has(id)) return
        const turns = turnsSinceSave.get(id) ?? 0
        const elapsed = Date.now() - (lastSaveAt.get(id) ?? 0)
        if (turns >= MIN_TURNS_BEFORE_IDLE_SAVE || elapsed >= MIN_INTERVAL_MS_BEFORE_IDLE_SAVE) {
          scheduleSave(id, "idle").catch(() => {})
        }
        return
      }

      if (event.type === "session.compacted") {
        const id = event.properties.sessionID
        if (!isRelevantSession(id)) return
        scheduleSave(id, "compaction").catch(() => {})
      }
    },

    "command.execute.before": async (input) => {
      if (input.command !== "scratch") return
      scratchSessions.add(input.sessionID)
      injectedSessions.add(input.sessionID) // pre-empt any pending injection
    },

    "chat.message": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID || internalSessions.has(sessionID)) return

      rootSessions.add(sessionID) // best-effort; session.created should have already added it

      if (!AUTOMATION_DISABLED && !scratchSessions.has(sessionID) && !injectedSessions.has(sessionID)) {
        injectedSessions.add(sessionID)
        const context = await resolveCheckpointContext(sessionID)
        if (context) {
          output.parts.unshift({
            id: `prt_gitlab-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            sessionID,
            messageID: output.message.id,
            type: "text",
            text: context,
            synthetic: true,
          } as any)
          client.tui
            .showToast({
              body: { title: "Checkpoint loaded", message: "Restored saved context for this ticket.", variant: "info" },
            })
            .catch(() => {})
        }
      }

      if (!AUTOMATION_DISABLED && !scratchSessions.has(sessionID)) {
        dirty.add(sessionID)
      }
    },

    tool: {
      gitlab_checkpoint_save: tool({
        description:
          "Save or update the context checkpoint for the current ticket ($TICKET_ID) to a private personal " +
          "GitLab snippet, via the shared ex context-checkpoint skill. Use to preserve the plan, key " +
          "decisions, findings, progress, blockers, and next steps for a later /resume — possibly from a " +
          "different machine or after context is lost/compacted. Writes immediately, no confirmation prompt " +
          "— safety comes from ticket-only scoping, compare-and-swap, and secret scanning, not from asking " +
          "first. Unavailable outside a ticket worktree (no TICKET_ID). If a checkpoint already exists, you " +
          "must call gitlab_checkpoint_resume first, merge its content with what's new, and pass its " +
          "updatedAt back here — this tool refuses to blindly overwrite. Note: most checkpoints are now " +
          "saved automatically in the background; call this directly only for an explicit /checkpoint or " +
          "when you need a save to happen immediately.",
        args: {
          title: tool.schema.string().describe("Short human title, e.g. the ticket summary or task name."),
          body: tool.schema
            .string()
            .describe(
              "Markdown body with clear section headers: Status, Goal, Outcome, Decisions, Findings, Plan, " +
                "Progress (a task list), Blockers, Next steps, Changes, Verification, References. Should be a " +
                "merge of any existing checkpoint plus what's new — never a regression.",
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
            const t = ticket()
            if (t) lastSavedHash.set(t, hash(args.body))
            // Don't let an idle/compaction trigger immediately regenerate a
            // near-duplicate right after this explicit save.
            if (ctx.sessionID) resetSaveState(ctx.sessionID)
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
          "Unavailable outside a ticket worktree (no TICKET_ID). The current checkpoint (if any) is already " +
          "auto-loaded at session start — use this tool to re-check after a possible external update, or to " +
          "get the updatedAt needed before calling gitlab_checkpoint_save.",
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
  }
}) satisfies Plugin
