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
//   - Auto-checkpoint: saves happen automatically — 2 minutes after the
//     session actually goes quiet (debounced; a new prompt cancels the
//     pending save and it re-arms next time the session goes idle),
//     immediately after compaction, and immediately on an explicit
//     /checkpoint. There is no ctx.ask() gate on writes; safety comes from
//     ticket-only scoping, ticket-level serialization, compare-and-swap,
//     secret scanning, and merge-before-write — not from a human click.
//     The generated Markdown is produced in a throwaway child session
//     (agent: build, no file/bash/task tools) so it never pollutes the
//     visible conversation.
//   - Opt-out: `/scratch <task>` marks the current session to skip both
//     auto-resume and auto-checkpoint (in-memory only — does not survive an
//     OpenCode restart). `CACHE=0` disables both automatic pathways for the
//     whole process. Neither affects explicit /checkpoint or /resume.

const RUN_SH = `${process.env.HOME}/.agents/plugins/ex/skills/context-checkpoint/run.sh`

// Process-wide escape hatch: disables auto-resume injection AND automatic
// saves. Explicit /checkpoint and /resume still work.
const AUTOMATION_DISABLED = process.env.CACHE === "0"

// "Idle" in OpenCode means "the agent just finished responding," not "the
// user has been inactive" — it fires after every completed prompt. Saving
// on every idle would mean saving after every single message, so instead
// we debounce: each idle (re)starts this countdown, and it only actually
// fires if the session stays quiet — no new prompt — for the full window.
const IDLE_DEBOUNCE_MS = 2 * 60 * 1000 // 2 minutes

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

If the existing checkpoint uses an older, plainer layout (flat "## Goal" \
/ "## Decisions" / etc. headers with no title or status line), migrate \
its content into the layout below on this save — carry every fact \
forward, don't just paste the old body underneath the new headers.

Use exactly this layout, in this order:

# <TICKET>: <short human title for the ticket, a few words>

> **Status:** \`<ACTIVE|BLOCKED|COMPLETED|ABANDONED>\`
> **Current focus:** <the single most relevant one-line thing right now>
> **Updated:** <use the exact "Updated" value given below>

---

## Workboard

A Markdown task list. Preserve existing items verbatim across saves. \
Check off items that are now done (\`- [x]\`). Add new items discovered \
this session. Never delete an item — mark a superseded one as \
\`- [x] ~~text~~ (cancelled)\` instead.

**Next move:** <the single next concrete action, one line>

### Blockers

Bullet list of open blockers, or the literal text \`_None._\` if there \
are none.

---

## Context

### Goal

### Decisions

Bullet list. Bold a short label for each decision, then the detail, e.g. \
\`- **Storage:** one snippet per ticket.\`

### Findings

---

## Delivery

### Changes

A short Markdown table of key files/components touched, with columns \
\`Area\` and \`Summary\`. Not raw diffs. Use \`_None yet._\` if nothing has \
changed yet.

### Verification

A Markdown task list of tests run and their results (checked if passing).

### References

Bullet list, e.g. \`- Jira: <ticket>\`, \`- Merge request: <url or \
_Not opened_>\`.

### Outcome

What ultimately happened. Use the literal text \`_In progress._\` while \
Status is ACTIVE or BLOCKED.

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

  // Child (subagent/task) sessions we've seen, so idle/compaction handling
  // never fires for them — only for the primary session a human is
  // actually talking to. Populated from session.created's parentID; a
  // session we haven't seen created (shouldn't normally happen) is treated
  // as relevant by default rather than silently ignored.
  const childSessions = new Set<string>()
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

  // Dirty tracking is generation-based, not a plain boolean, so a save
  // in flight can't clobber a newer change that arrived while it was
  // still reading/generating/writing. A session is dirty whenever its
  // dirtyGeneration is ahead of its savedGeneration.
  const dirtyGeneration = new Map<string, number>()
  const savedGeneration = new Map<string, number>()
  const pendingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastSavedHash = new Map<string, string>() // per ticket

  // Serializes saves (automatic and manual alike) so overlapping
  // idle/compaction/manual triggers for the same process never race each
  // other's read-merge-write cycle.
  let saveChain: Promise<void> = Promise.resolve()
  const withSaveChain = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = saveChain.catch(() => {}).then(fn)
    saveChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const hash = (s: string) => createHash("sha256").update(s).digest("hex")

  const isRelevantSession = (sessionID: string) =>
    !internalSessions.has(sessionID) && !childSessions.has(sessionID) && !scratchSessions.has(sessionID)

  const markDirty = (sessionID: string) => {
    dirtyGeneration.set(sessionID, (dirtyGeneration.get(sessionID) ?? 0) + 1)
  }

  const isDirty = (sessionID: string) =>
    (dirtyGeneration.get(sessionID) ?? 0) !== (savedGeneration.get(sessionID) ?? 0)

  const clearPendingSave = (sessionID: string) => {
    const timer = pendingSaveTimers.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      pendingSaveTimers.delete(sessionID)
    }
  }

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

  const formatTrigger = (reason: string): string => {
    switch (reason) {
      case "idle":
        return "OpenCode (idle save)"
      case "compaction":
        return "OpenCode (after compaction)"
      default:
        return `OpenCode (${reason})`
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
    const updatedValue = `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC via ${formatTrigger(reason)}`

    const userPrompt =
      `Ticket: ${ticket()}\n` +
      `Use this exact value for the "Updated" line: ${updatedValue}\n\n` +
      `${existingBlock}\n\n` +
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

  const doSave = async (rootSessionID: string, reason: string): Promise<void> => {
    const t = ticket()
    if (!t) return

    // Snapshot which "version" of dirty we're about to capture. If a new
    // message arrives while we're still reading/generating/writing below,
    // dirtyGeneration will have moved past this by the time we finish —
    // and savedGeneration must not be advanced past what we actually
    // captured, or that newer change would be lost (treated as saved when
    // it never was).
    const targetGeneration = dirtyGeneration.get(rootSessionID) ?? 0

    const existing = await readExistingCheckpoint()
    if (existing === undefined) {
      // Lookup failed — abort rather than risk creating a duplicate snippet.
      return
    }

    const markdown = await generateCheckpointMarkdown(rootSessionID, existing, reason)
    if (!markdown) return

    const bodyHash = hash(markdown)
    if (lastSavedHash.get(t) === bodyHash) {
      savedGeneration.set(rootSessionID, targetGeneration)
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
        // Leave dirty (don't advance savedGeneration) so the next
        // idle/compaction trigger retries.
        await client.app
          .log({ body: { service: "gitlab-checkpoint", level: "warn", message: "auto-save failed", extra: { reason, result } } })
          .catch(() => {})
        return
      }

      lastSavedHash.set(t, bodyHash)
      savedGeneration.set(rootSessionID, targetGeneration)
      client.tui
        .showToast({ body: { title: "Checkpoint saved", message: `${t} (${reason})`, variant: "info" } })
        .catch(() => {})
    } finally {
      unlinkSync(bodyPath)
    }
  }

  const scheduleSave = (rootSessionID: string, reason: string) => withSaveChain(() => doSave(rootSessionID, reason))

  // Debounced idle trigger: every idle event restarts this session's
  // countdown. It only actually fires once the session has gone genuinely
  // quiet for the full window — a new prompt (chat.message) cancels it
  // outright, and the next idle after that re-arms a fresh countdown.
  const scheduleIdleSave = (sessionID: string) => {
    clearPendingSave(sessionID)
    const timer = setTimeout(() => {
      pendingSaveTimers.delete(sessionID)
      if (!isRelevantSession(sessionID) || !isDirty(sessionID)) return
      scheduleSave(sessionID, "idle").catch(() => {})
    }, IDLE_DEBOUNCE_MS)
    pendingSaveTimers.set(sessionID, timer)
  }

  return {
    dispose: async () => {
      // Don't just drop a debounced save that hasn't fired yet — we're
      // exiting, so there's no point waiting for the session to "go
      // quiet"; flush it now instead, within the shutdown budget below.
      for (const id of [...pendingSaveTimers.keys()]) {
        clearPendingSave(id)
        if (isRelevantSession(id) && isDirty(id)) scheduleSave(id, "shutdown").catch(() => {})
      }
      await Promise.race([saveChain.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))])
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        const info = event.properties.info
        if (!info) return
        if (info.parentID) childSessions.add(info.id)
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
        clearPendingSave(id)
        childSessions.delete(id)
        internalSessions.delete(id)
        scratchSessions.delete(id)
        injectedSessions.delete(id)
        checkpointCache.delete(id)
        dirtyGeneration.delete(id)
        savedGeneration.delete(id)
        return
      }

      if (AUTOMATION_DISABLED) return

      if (event.type === "session.status" && event.properties.status?.type === "idle") {
        const id = event.properties.sessionID
        if (!isRelevantSession(id) || !isDirty(id)) return
        scheduleIdleSave(id)
        return
      }

      if (event.type === "session.compacted") {
        const id = event.properties.sessionID
        if (!isRelevantSession(id)) return
        // Compaction is a good moment to snapshot regardless of the idle
        // debounce — context is about to be compressed, so don't wait.
        clearPendingSave(id)
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
        // A new prompt means the session is active again — cancel any
        // countdown from a previous idle so it doesn't fire mid-conversation;
        // the next idle after this one re-arms it.
        clearPendingSave(sessionID)
        markDirty(sessionID)
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
              "Markdown body using the layout: a '# <TICKET>: <title>' heading, a blockquote with Status/" +
                "Current focus/Updated, a Workboard task list with a Blockers subsection, a Context section " +
                "(Goal/Decisions/Findings), and a Delivery section (Changes/Verification/References/Outcome). " +
                "See the /checkpoint command for the exact template. Should be a merge of any existing " +
                "checkpoint plus what's new — never a regression, and migrate an older plain-header " +
                "checkpoint into this layout rather than leaving it as-is.",
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
            // Route through the same serialization as automatic saves so a
            // concurrent idle/compaction save can't race this write.
            const result = await withSaveChain(async () => {
              const saveArgs = ["save", args.title, bodyPath]
              if (args.expectedUpdatedAt) saveArgs.push(args.expectedUpdatedAt)
              return run(saveArgs)
            })
            if (result.startsWith("ERROR")) {
              return { title: "Checkpoint not saved", output: result }
            }
            const t = ticket()
            if (t) lastSavedHash.set(t, hash(args.body))
            // Don't let a pending idle/compaction trigger immediately
            // regenerate a near-duplicate right after this explicit save.
            if (ctx.sessionID) {
              clearPendingSave(ctx.sessionID)
              savedGeneration.set(ctx.sessionID, dirtyGeneration.get(ctx.sessionID) ?? 0)
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
