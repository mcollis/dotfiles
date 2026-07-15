# Agent assets

`AGENTS.md` is the canonical harness-neutral instruction file. Harness-specific
configuration lives under `adapters/`: Claude and Codex expose it under their
expected filenames, while OpenCode loads it through its `instructions` setting.

User skills are flat under `skills/`. The `ex` plugin and depot project bundle
are separate Git submodules under `plugins/ex` and `projects/depot`.

Generic hook implementations live under `hooks/`. Harness-specific registration
lives under `adapters/`.

Run `.agents/stow.sh check` before installing changes. `.agents/stow.sh install` creates
symlink projections in `~/.claude`, `~/.codex`, and `~/.config/opencode` for
the harness adapters and project bundles. OpenCode plugin dependencies are
excluded from source; run `npm ci` in `~/.config/opencode` after installing on
a new machine. After
installing the depot bundle, run
`~/.agents/projects/depot/worktrunk/install.sh --dry-run` before installing its
project-scoped Worktrunk hooks.
