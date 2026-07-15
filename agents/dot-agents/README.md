# Agent setup

`AGENTS.md` and `skills/` are canonical harness-neutral assets. Claude and
Codex receive the shared `skills/` directory through links to `~/.agents`.
`plugins/ex` and `projects/depot` are Git submodules, exposed at `~/.agents/`
after Stow. The [repository README](../../README.md) documents the general
Stow workflow and all packages.

## Layout

```text
agents/dot-agents/              -> ~/.agents/
claude/dot-claude/              -> ~/.claude/
codex/dot-codex/                -> ~/.codex/
opencode/dot-config/opencode/   -> ~/.config/opencode/
```

Claude and Codex roots stay real directories. Stow manages only their stable
entries, so runtime state can coexist with the links. `~/.claude/settings.json`
and `~/.codex/config.toml` are application-owned local files and are never
Stowed.

## New machine

From the dotfiles repository, initialize the agent directories before Stowing
the `agents`, `claude`, `codex`, or `opencode` packages:

```sh
mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.config"
[ -e "$HOME/.claude/settings.json" ] || cp templates/claude-settings.json "$HOME/.claude/settings.json"
[ -e "$HOME/.codex/config.toml" ] || : > "$HOME/.codex/config.toml"
mkdir -p "$HOME/.agents"
ln -s "$(pwd)/agents/dot-agents/skills" "$HOME/.agents/skills"
ln -s ../.agents/skills "$HOME/.claude/skills"
ln -s ../.agents/skills "$HOME/.codex/skills"
```

Then follow the root README's dry-run and install commands.

GNU Stow follows source directory symlinks, so it cannot create these three
whole-directory links itself. They ensure a skill created through Claude or
Codex is created in the canonical repository directory and immediately shared.
Run them before first launching Codex on a new machine; Codex writes its
app-managed `skills/.system/` directory there, which is intentionally ignored.

Install only the packages wanted on a machine with, for example:

```sh
stow -v agents claude codex
stow -D -v opencode
```

Use `stow -R -v <package>` after changing a package's file layout.

## Agent integrations

OpenCode dependencies are local runtime state:

```sh
npm ci --prefix "$HOME/.config/opencode"
```

Register and install the `ex` Claude plugin per machine. Its installation state
is intentionally not tracked:

```sh
claude plugin marketplace add "$HOME/.agents/plugins/ex/.claude-plugin/marketplace.json"
claude plugin install ex@ex-agents-marketplace --scope user
```

The `ex` repository documents its own behavior and requirements. For Depot's
project-scoped Worktrunk hooks, inspect the installer before applying it:

```sh
"$HOME/.agents/projects/depot/worktrunk/install.sh" --dry-run
```
