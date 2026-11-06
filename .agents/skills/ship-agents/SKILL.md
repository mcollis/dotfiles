---
name: ship-agents
description: Release agent-configuration changes (skills, instructions, hooks, plugins) and keep their deployed copies current. Use when the user says "ship agents", "refresh agents", or "check rollout", or says "ship it" right after agent-tooling work with no other release in play. Commits and pushes the canonical repositories in dependency order, bumps parent pointers, refreshes only verifiably stale copies (adding absent files where safe), and reports what is published and what is stale. Not for ticket or product code releases.
---

# Ship Agents

Coordinates the maintenance chain after agent-configuration work, so the user does not have to name every dependent step. It discovers the chain, shows it, and executes only what was previewed and approved.

| User says | Mode | Reads | Changes |
|---|---|---|---|
| "ship agents" | **ship** | `references/release.md`, then `references/refresh.md` | commits, pushes, pointer bumps, refreshes, once approved |
| "refresh agents" | **refresh** | `references/refresh.md` | stale copies only, once approved |
| "check rollout" | **check** | `references/refresh.md` | nothing |
| "ship it" | **ship**, only if the work just done was agent tooling and no other release is in play; otherwise ask once what to ship | | |

## Flow

1. **Discover (read-only).** Find what changed and where it lives; do not rely on remembered paths.
   - Changed files: from the session and `git status` in the agent roots (default `~/.agents`, plus any `roots` in the optional `${XDG_CONFIG_HOME:-~/.config}/ship-agents/config.json`).
   - Owning repository for each file: `git rev-parse --show-toplevel`. Parent relationships: `git rev-parse --show-superproject-working-tree`, `git submodule status`. If a repository is managed by a dotfiles tool with its own git wrapper (such as yadm), use that wrapper for it, not plain git.
   - Deployed copies: read the bundle's own README or setup script to learn how its files are projected into worktrees or other locations. Read it; never run it to find out.
2. **Preview.** Present one numbered list of the exact operations, in execution order. Each entry names the repository, the explicit file paths, the commit message (draft it with the `commit-message` skill), the commit identity that repository will use, the remote and branch, and for refresh the exact copies, files to replace, files to add, and directories to create. Also list what is excluded and why: unrelated changes, generated files, copies that are modified or unverifiable.
3. **One approval.** The user approves the listed sequence once. That covers exactly those operations. Do not re-ask between steps. If the session is in a read-only planning mode, request the switch to Build for exactly this list.
4. **Execute in dependency order.** Child repositories first (commit, push), then each parent that references them (pointer commit, push), then approved refreshes. Details in the references.
5. **Verify and report.** A compact table: each repository's local and remote tips and whether they match, each pointer, each copy as current / refreshed / stale / missing files / locally modified / unverified. Mention at most one follow-up.

## Hard rules

- A changed scope, an unexpected staged or modified file, a diverged branch, a failed hook, or any failed operation stops the sequence. Report what succeeded, what did not, and what remains. Do not improvise recovery.
- Stage explicit paths only, and confirm `git diff --cached --name-only` equals the previewed list before every commit. Never `add .`, `add -A`, force push, rebase, amend, `--no-verify`, or change any git identity or configuration.
- Pushes use plain git over the repository's configured remote. Never override or change credentials. If a push is refused, report it.
- Never run a setup or bootstrap hook that deletes and recreates a destination to refresh a copy. Never touch a copy that is modified or cannot be verified.
- Preserve unrelated changes and existing staging in every repository.
- Do not run tests, builds, services, or restarts unless they are part of the approved list. Files being current does not mean a running agent loaded them; say which sessions or services may need a reload, and do not do it.
- Keep personal repository names, paths, and hosts out of what you write into this skill; discovery supplies them each time.

## Optional configuration

`ship-agents/config.json` is never required and is never created by this skill. Keys: `roots` (extra canonical roots to scan) and `deployments` (entries with `source`, an optional file `mapping`, and `copies` globs) for projections discovery cannot determine.
