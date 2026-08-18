# Hooks

Place harness-neutral hook implementations directly in this directory.
Harness-specific registration belongs with the harness adapter:

- Claude registration is in `claude/settings.json`.
- Codex registration is in `codex/hooks.json`.

Herdr-generated scripts are externally managed and should be referenced rather
than copied into this tree.
