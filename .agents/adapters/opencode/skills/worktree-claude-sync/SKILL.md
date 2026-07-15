---
name: worktree-claude-sync
description: One-way mirror of `$CLAUDE_HOME` (`<bare>/claude/`) into the current worktree's `.claude/`. Surfaces any worktree-side edits before mirroring so they can be pushed back to canonical. Use when the user asks to sync claude config, refresh skills/conventions in a worktree, push a worktree edit back to canonical, or fix `.claude/` drift. Also invoked from `worktree-prune`.
---

# Mirror `$CLAUDE_HOME` into the worktree

Canonical state lives at `$CLAUDE_HOME` (the per-repo `<bare>/claude/`). Each worktree's `.claude/` is a refreshable copy. Edits inside a worktree are allowed but discouraged — when this skill runs, it lists any such edits and asks whether to push them up to canonical before mirroring the latest canonical state down.

The actual mirror is **delegated to worktrunk**: the `pre-start claude` hook in `~/.config/worktrunk/config.toml` owns the canonical → worktree copy (`rm -rf "$WT/.claude"; cp -r "$CLAUDE_HOME"`). This skill runs that hook on-demand via `wt -C <worktree> hook pre-start claude --yes` for its apply step, so the copy logic lives in exactly one place. The skill's own value is the **push-back gate**: detecting worktree-side edits and offering to push them to canonical *before* the hook blindly clobbers `.claude/`.

## Arguments / flags

- `--worktree <path>` — target worktree (defaults to `$PWD`-resolved).
- `--push <file>...` — push specific files (paths relative to `.claude/`) from worktree → canonical, then mirror.
- `--no-push-back` — proceed with the mirror even if the worktree has edits (clobbers them; worktree-only files left in place).
- `--dry-run` — report what would happen.

## Output contract

Line-oriented for parsing:

- `EDIT=<rel-path>` — file in worktree differs from canonical (or canonical doesn't have it).
- `MIRROR=<rel-path>` — file in canonical differs from worktree (or worktree doesn't have it).
- `SUMMARY=EDIT=<n> MIRROR=<m> ...` — totals + paths.

After the listing, when not `--dry-run`, the script prints `=== EDIT diffs ===` with up to 20 lines of `diff -u` per edited file.

## How to use this skill

1. Run `/home/michaelco/.claude/plugins/ex/skills/worktree-claude-sync/run.sh --dry-run` to see EDIT/MIRROR lines without changing anything.
2. If `EDIT=` lines appear, read each one's diff snippet. For each, decide with the user:
   - **Push back** (the edit should become canonical) → re-run with `--push <file>`.
   - **Discard** (edit is local-only experimentation) → re-run with `--no-push-back` so the mirror clobbers it.
   - **Keep local for now** → don't run the mirror; the worktree retains the edit until next time.
3. After resolving EDITs, re-run `/home/michaelco/.claude/plugins/ex/skills/worktree-claude-sync/run.sh` (no flags) to apply the mirror.

## Always-excluded paths

Drift detection (the `EDIT=`/`MIRROR=` pass) excludes:
- `settings.local.json` — see below.
- `*.sync.bak.*` — debris from prior bidirectional sync; `cleanup.sh` removes any that already exist.
- `.git/` — defensive (claude.git is not currently used, but the exclude is cheap).

### On `settings.local.json`

Canonical `claude/` no longer ships one. The project-level state it used to hold (MCP enablement, depot-worktrees permission globs, hook timeouts) was folded into the synced `settings.json`; genuinely per-machine, per-user state (tokens, `$HOME`-specific paths) belongs in `~/.claude/settings.json` (user scope).

It stays excluded from drift detection because the apply step delegates to `wt hook pre-start claude`, a wholesale `rm -rf "$WT/.claude"; cp -r` of canonical — so any worktree-side `settings.local.json` is clobbered no matter what. Surfacing it as an `EDIT=` would only offer to push the deleted file *back* to canonical, which is wrong. The `worktree-prune` `SYNC_BACK=` heuristic carries the same exclude for the same reason.

## One-shot scripts in this dir

- `cleanup.sh` — removes `*.sync.bak.*` files left over from the prior bidirectional model.
- `unmigrate-hook.sh` — removes the obsolete `worktree-claude-sync` SessionStart hook entry from each worktree's `settings.json`.

Both are idempotent and read-from `lib/repo.sh` to discover paths. Invoke them by absolute path:
`/home/michaelco/.claude/plugins/ex/skills/worktree-claude-sync/cleanup.sh` and
`/home/michaelco/.claude/plugins/ex/skills/worktree-claude-sync/unmigrate-hook.sh`.
