# Agent assets

`AGENTS.md` is the canonical harness-neutral instruction file. The Claude and
Codex adapter directories expose it under each harness's expected filename.

User skills are flat under `skills/`. The `ex` plugin and depot project bundle
are separate Git submodules under `plugins/ex` and `projects/depot`.

Generic hook implementations live under `hooks/`. Harness-specific hook
registration lives in `claude/settings.json` and `codex/hooks.json`.

Run `.agents/stow.sh check` before installing changes. `.agents/stow.sh install` creates
symlink projections for the harness adapters and project bundles. After
installing the depot bundle, run
`~/.agents/projects/depot/worktrunk/install.sh --dry-run` before installing its
project-scoped Worktrunk hooks.
