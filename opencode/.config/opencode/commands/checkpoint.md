---
description: Save the current ticket's plan/context to a private GitLab snippet for later /resume. Requires a ticket-scoped worktree (TICKET_ID).
---

Requires `$TICKET_ID` to be set (a ticket-scoped worktree). If it isn't, `gitlab_checkpoint_save`/`gitlab_checkpoint_resume` will fail with a clear error — tell the user this isn't available here rather than improvising a substitute key.

1. Call `gitlab_checkpoint_resume` first to check for an existing checkpoint. If one exists (`Checkpoint found`), read its content and `updatedAt`.
2. **Merge, don't overwrite.** If a checkpoint already exists, combine what's already there with what's new this session — keep prior Decisions/Findings that are still valid, and layer in new progress. Never regress a richer stored checkpoint down to just this session's (possibly thinner, e.g. post-compaction) context.
3. Gather/update: **Goal**, **Decisions**, **Findings**, **Plan**, **Progress**, **Blockers**, **Next steps**, as structured Markdown.
4. **Ask the user to confirm** with a one-line summary of what's actually changing — not just "save checkpoint". If there's nothing new to add, say so and stop; don't call the tool.
5. Call `gitlab_checkpoint_save` with `title`, `body` (the merged content), and `expectedUpdatedAt` set to the value from step 1 (omit only if step 1 found no existing checkpoint).
6. The tool enforces merge-before-write mechanically: it refuses if an existing checkpoint's `updatedAt` wasn't supplied or doesn't match, and reports `UNCHANGED` as a no-op if the merged body is identical to what's stored. Report the result (`CREATED`/`UPDATED`/`UNCHANGED`/error) back to the user plainly.
