---
description: Force an immediate save of the current ticket's checkpoint to a private GitLab snippet for later /resume. Requires a ticket-scoped worktree (TICKET_ID).
agent: build
---

Requires `$TICKET_ID` to be set (a ticket-scoped worktree). If it isn't, `gitlab_checkpoint_save`/`gitlab_checkpoint_resume` will fail with a clear error — tell the user this isn't available here rather than improvising a substitute key.

This command always runs under the `build` agent (set in its frontmatter), even if you invoked it from `plan` — that's a deliberate delegation, not something to second-guess.

Checkpoints normally save themselves automatically in the background (on meaningful idle and after compaction) — this command just forces one right now, e.g. before a risky operation or before ending the session.

Current UTC time for the "Updated" line: !`date -u +"%Y-%m-%d %H:%M"`

1. Call `gitlab_checkpoint_resume` first to check for an existing checkpoint. If one exists (`Checkpoint found`), read its content and `updatedAt`.
2. **Merge, don't overwrite.** If a checkpoint already exists, combine what's already there with what's new this session — keep prior sections that are still valid, check off completed Workboard items, and layer in new Decisions/Findings/Changes/Verification/References/Blockers. Never regress a richer stored checkpoint down to just this session's (possibly thinner, e.g. post-compaction) context.
3. Gather/update the body using exactly this layout, in this order — migrate an older, plainer checkpoint (flat `## Goal`/`## Decisions` headers, no title or status line) into it, carrying every fact forward:

   ````markdown
   # <TICKET>: <short human title>

   > **Status:** `<ACTIVE|BLOCKED|COMPLETED|ABANDONED>`
   > **Current focus:** <the single most relevant one-line thing right now>
   > **Updated:** <the UTC time above> via OpenCode (manual /checkpoint)

   ---

   ## Workboard

   - [ ] <not done>
   - [x] <done>

   **Next move:** <the single next concrete action>

   ### Blockers

   <bullet list, or `_None._`>

   ---

   ## Context

   ### Goal

   ### Decisions

   - **<short label>:** <detail>

   ### Findings

   ---

   ## Delivery

   ### Changes

   | Area | Summary |
   | --- | --- |
   | <area> | <what changed> |

   ### Verification

   - [x] <test/check that passed>
   - [ ] <test/check still pending>

   ### References

   - Jira: <ticket>
   - Merge request: <url, or `_Not opened_`>

   ### Outcome

   <what ultimately happened, or `_In progress._` while Status is ACTIVE/BLOCKED>
   ````
4. Call `gitlab_checkpoint_save` with `title`, `body` (the merged content), and `expectedUpdatedAt` set to the value from step 1 (omit only if step 1 found no existing checkpoint). It writes immediately — no confirmation step.
5. The tool enforces merge-before-write mechanically: it refuses if an existing checkpoint's `updatedAt` wasn't supplied or doesn't match, and reports `UNCHANGED` as a no-op if the merged body is identical to what's stored. Report the result (`CREATED`/`UPDATED`/`UNCHANGED`/error) back to the user plainly.

