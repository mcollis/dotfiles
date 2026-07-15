---
name: worktree-prune
description: Prune stale remote-tracking branches and identify orphaned worktrees, local branches, tmux windows, Playwright/anchorhead daemons, agent-browser sessions, and worktree-scoped Docker resources. Use when user asks to prune, clean up branches, or tidy worktrees.
---

# Git Prune and Cleanup

Prunes stale remote-tracking branches and identifies orphaned resources tied to worktrees (branches, tmux windows, containers, `vsc-user-*` images, dangling networks/volumes).

Scoped to the current repo: Docker resources, Playwright daemons, and tmux windows are filtered to those tied to the current repo's `WORKTREES_DIR`. Run from another repo's worktree (or its bare repo) to clean up that repo's resources.

Does NOT touch generic Docker cruft (untagged `depot-stage/combined` images, build cache, unrelated dangling volumes). That lives in `/docker-prune`.

## Instructions

### 0. Optional fast-path: `wt step prune`

Before running full discovery, you can quickly surface worktrees already merged
into the default branch:

```bash
wt step prune --dry-run
```

These are high-confidence safe-to-remove candidates (no Jira/MR check needed —
`wt`'s merge detection covers squash/rebase/fast-forward). If the user wants to
act on them immediately, run `wt remove --foreground <branch>` (hooks handle
`make stop` + tmux cleanup). Then proceed to step 1 for the fuller discovery
(remote prune, metadata prune, Docker/Playwright/tmux orphans). Note: `wt step
prune` is experimental and does **not** run cleanup hooks on its own — always
use `wt remove` for actual removal.

### 1. Run the discovery script

```bash
"$HOME/.agents/plugins/ex/skills/worktree-prune/run.sh"
```

The script is read-only. It outputs structured sections:

- **PRUNED REMOTE BRANCHES** — branches already cleaned up (safe, non-destructive)
- **PRUNED WORKTREE METADATA** — stale worktree metadata whose directory was deleted externally (safe, non-destructive)
- **ORPHANED WORKTREES** — worktrees whose remote branch no longer exists (PATH, BRANCH, TICKET, STATUS, SAFE_TO_REMOVE per entry)
- **ORPHANED LOCAL BRANCHES** — local `user/*/EX-*` branches with no remote and no worktree
- **ORPHANED PLAYWRIGHT DAEMONS** — anchorhead `cliDaemon.js` processes (and their headless Chromes) whose worktree no longer exists
- **ORPHANED AGENT-BROWSER SESSIONS** — `ab-<worktree>` sessions (from the depot `agent-browser` skill) whose worktree no longer exists (SESSION per entry). One shared daemon serves all sessions, so these are reaped per-session via `close`, not by killing a PID.
- **ORPHANED DOCKER CONTAINERS** — containers matching branch patterns not in active worktrees
- **ORPHANED VSC DEVCONTAINER IMAGES** — `vsc-user-*` images matching branch patterns not in active worktrees
- **ORPHANED DOCKER NETWORKS** — dangling `ex-*`/`user-*` networks not in active worktrees
- **ORPHANED TMUX WINDOWS** — tmux windows whose `@wl` matches any orphaned ticket

Each orphaned worktree and local branch is checked for safety:

1. **GitLab MR** first — `MR=merged` → `SAFE_TO_REMOVE=YES`
2. **Jira status** as fallback — only statuses considered complete (via `is_jira_resolved`, including any repo-specific additions from `.claude/conventions/jira.md`) mark the item safe

### 2. Present findings and confirm cleanup

Show the user a summary of what was found in each category, including Jira/MR status. Only recommend removing items marked `SAFE_TO_REMOVE=YES`. For items marked `NO`, inform the user the ticket is still active and skip them by default. For each non-empty category with safe items, ask for confirmation before removing.

### 3. Execute confirmed removals

Run the appropriate commands for each confirmed category:

- **Worktrees**: `wt remove --foreground <branch>` — removes the worktree and deletes the branch in one step. `wt` hooks (in `<bare>/wt-hooks/`) stop containers and close the tmux window automatically. `--foreground` ensures removal completes before the summary. If `wt` reports the branch has unmerged commits, ask before re-running with `-D`; add `--force` if the worktree has uncommitted changes (ask first).
- **Local branches** (orphan with no worktree): `wt remove --foreground <branch>`, or fall back to `git branch -d <branch>` (ask before `-D`)
- **Tmux windows**: `tmux kill-window -t <session>:<window_index>`
- **Playwright daemons**: `kill <pid>` (child Chrome processes exit with the daemon)
- **agent-browser sessions**: `agent-browser --session <name> close` (tears down that session's browser; the shared daemon and other sessions stay up)
- **Docker containers**: `docker rm <id>`
- **VSC devcontainer images**: `docker rmi <id>` (these are typically ~22GB each)
- **Docker networks**: `docker network rm <id>`

### 4. Display summary

Pruned remote branches, removed worktrees, deleted local branches, closed tmux windows, removed Docker containers/images (with total space reclaimed), remaining worktrees with active remotes.

## Related

For generic Docker cleanup (untagged base images, build cache, dangling volumes not tied to worktrees), run `/docker-prune` as a separate step.
