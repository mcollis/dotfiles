---
description: Resume from the current ticket's saved GitLab snippet checkpoint. Requires a ticket-scoped worktree (TICKET_ID).
---

Requires `$TICKET_ID` to be set (a ticket-scoped worktree). If it isn't, `gitlab_checkpoint_resume` will fail with a clear error — tell the user this isn't available here.

1. Call `gitlab_checkpoint_resume`.
2. If no checkpoint is found, tell the user there's nothing saved for this ticket.
3. If one is found, summarize it for the user (goal, decisions, plan, progress, blockers, next steps) and propose how to continue. This is read-only and needs no confirmation to load — the user invoked `/resume` explicitly, which is the approval.
