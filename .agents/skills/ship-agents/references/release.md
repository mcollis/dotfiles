# Release: commit, push, and pointer bumps

Applies in **ship** mode after the user approves the previewed list. Each step below is already covered by that one approval; re-ask only when something differs from the preview.

## Order

Dependencies first. Build a graph from the discovered relationships: a repository that another repository records as a submodule or pinned reference is a child. Release leaves before their parents. A parent pointer commit never precedes the push of the commit it points at.

## Per repository

1. **Check the starting state.** Branch matches the preview, working tree contains only expected changes, no unexpected staged files, and the branch is not behind or diverged from its upstream (`git fetch` is a read, so it is allowed). If it is behind or diverged, stop.
2. **Stage explicit paths** from the preview, then verify `git diff --cached --name-only` equals that list exactly. Extra staged files that were not previewed mean stop, not unstage.
3. **Commit** with the previewed message and the repository's own configured identity. Load the `commit-message` skill for drafting, and never add attribution trailers. A failing hook stops the sequence; do not retry with `--no-verify`.
4. **Push** the branch to its configured upstream with plain `git push`. No force, no new remote, no credential changes.
5. **Verify** with `git ls-remote <remote> <branch>`: the remote tip must equal the local `HEAD`. Record both.

## Pointer bumps

For each parent that records a child at a pinned revision:

1. Confirm the child's pushed tip is the revision to record. If the parent already points at it, report "pointer current" and skip.
2. Stage only the child's path in the parent. Confirm nothing else is staged.
3. Commit with a short message in the parent's own style (sample its history). Use the parent's own wrapper or tool when it has one.
4. Push and verify exactly as above.

A parent with unrelated modified files is normal; leave them untouched and unstaged. Do not widen the commit to include them.

## Stop and report

On any failure, print what completed (with tips), what failed (with the exact error), and what was not attempted. Do not push later steps, do not undo earlier ones, and do not retry with different options. The user decides the next step.
