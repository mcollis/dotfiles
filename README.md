# dotfiles

Personal macOS and Linux configuration managed with GNU Stow. Each top-level
directory is an independent Stow package. Package contents reproduce their
literal target paths, including hidden directories.

## Packages

| Package | Target |
| --- | --- |
| `agents` | `~/.agents/` |
| `claude` | `~/.claude/` |
| `codex` | `~/.codex/` |
| `opencode` | `~/.config/opencode/` |
| `direnv`, `ghostty`, `herdr`, `lazygit`, `nvim`, `worktrunk` | `~/.config/` |
| `shell`, `tmux` | `$HOME` |

See [the agent setup guide](agents/.agents/README.md) before installing
the agent packages on a new machine.

## Install

Clone the repository, initialize its submodules, and enter the clone:

```sh
git clone --recurse-submodules git@github.com:mcollis/dotfiles.git
cd dotfiles
git submodule update --init --recursive
```

Dry-run the packages you want, then run the same command without `-n`:

```sh
stow -n -v agents claude codex opencode direnv ghostty herdr lazygit nvim worktrunk shell tmux
stow -v agents claude codex opencode direnv ghostty herdr lazygit nvim worktrunk shell tmux
```

Install only the packages needed on the current machine:

```sh
stow -v nvim shell tmux
stow -D -v ghostty
```

`.stowrc` sets `--no-folding` and `--target=~`.
`--no-folding` ensures application directories such as `~/.claude`,
`~/.codex`, and `~/.config` remain real directories, allowing application
runtime state to coexist with Stow-managed links. Always dry-run before
changing a machine with existing configuration. Do not use `stow --adopt`;
it can import machine-specific state into this repository.

Use `stow -R -v <package>` after changing a package's file layout.

## Migrating Older Installs

Older revisions used `dot-*` source names. Before Stowing this revision, remove
only stale target symlinks that point to the old `<clone>/.config/...` source
layout, then dry-run the affected package. Existing real directories and local
files should remain in place.
