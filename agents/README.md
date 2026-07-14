# Agent assets

`AGENTS.md` is the canonical harness-neutral instruction file. The Claude and
Codex adapter directories expose it under each harness's expected filename.

User skills are flat under `skills/`. The `ex` plugin remains a separate Git
submodule under `plugins/ex` and contains both Claude and Codex manifests.

Generic hook implementations live under `hooks/`. Harness-specific hook
registration lives in `claude/settings.json` and `codex/hooks.json`.

Run `stow.sh check` before installing changes. `stow.sh install` creates
symlink projections for the harness adapters.
