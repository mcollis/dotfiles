# Agent setup

`AGENTS.md` and `skills/` are canonical harness-neutral assets. Claude and
Codex receive the shared `skills/` directory through links to `~/.agents`.
`plugins/ex` and `projects/depot` are Git submodules, exposed at `~/.agents/`
after Stow. The [repository README](../../README.md) documents the general
Stow workflow and all packages.

## Layout

```text
agents/.agents/              -> ~/.agents/
claude/.claude/              -> ~/.claude/
codex/.codex/                -> ~/.codex/
opencode/.config/opencode/   -> ~/.config/opencode/
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
[ -s "$HOME/.codex/config.toml" ] || cp templates/codex-config.toml "$HOME/.codex/config.toml"
```

Then follow the root README's dry-run and install commands.

The Codex template contains portable defaults. Codex maintains its local
project trust, plugin, and marketplace state after the copy.

The Claude and Codex packages use relative skill-directory symlinks that Stow
preserves. They resolve directly to `agents/.agents/skills`, so a skill created
through either harness is created in the canonical repository directory and
immediately shared. Codex writes its app-managed `skills/.system/` directory
there, which is intentionally ignored.

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

Register and install the `ex` Claude plugin per machine using
[its installation guide](plugins/ex/README.md#install). Its installation state
is intentionally not tracked. For Depot's project-scoped Worktrunk hooks,
inspect the installer before applying it:

```sh
"$HOME/.agents/projects/depot/worktrunk/install.sh" --dry-run
```
