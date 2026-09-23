# dotfiles

Personal macOS and Linux configuration managed with [yadm](https://yadm.io).
The yadm worktree is `$HOME`: stable configuration files are regular files at
their final paths, not links into a separate checkout.

## Profiles

- **Default**: no yadm class. Provides portable configuration and the current
  Bedrock model defaults without private ExtraHop bundles.
- **Work**: `local.class = Work`. Adds the EX and Depot submodules, internal
  workflows, and Worktrunk conventions.

Check the current profile with:

```sh
yadm config --get-all local.class
```

No output means the default profile.

## New Machine

On a new machine with no Stow deployment, install yadm with your system package
manager, then clone this repository.

```sh
yadm clone --bootstrap git@github.com:mcollis/dotfiles.git
```

For a Work machine, set the native yadm class before bootstrapping:

```sh
yadm clone --no-bootstrap git@github.com:mcollis/dotfiles.git
yadm config local.class Work
yadm bootstrap
```

Bootstrap is idempotent. It applies yadm alternatives, seeds missing mutable
Claude and Codex configuration, and generates `~/.config/worktrunk/config.toml`.
On Work machines it also initializes the EX and Depot submodules and reconciles
the Claude and Codex EX plugin registrations.

It intentionally does not install system packages, authenticate services, run
`npm ci`, or install Herdr integrations. Run these when applicable:

```sh
~/.config/yadm/scripts/bootstrap-shell.sh
npm ci --prefix ~/.config/opencode
```

Install Claude, Codex, and OpenCode integrations through the Herdr TUI, then
verify with `herdr integration status`.

## Daily Workflow

Edit stable files in place and add only explicit paths:

```sh
$EDITOR ~/.zshrc
yadm diff
yadm add ~/.zshrc
yadm commit
yadm push
```

Do not run `yadm add .`, `yadm add -A`, or `yadm add --all` from `$HOME`.

## Agent Skills

Shared standalone skills live in `~/.agents/skills`. Codex and OpenCode
discover that directory natively. Claude owns `~/.claude/skills` and receives
only an explicit `commit-message` link. EX and Depot bundle and register their
own skills through their respective plugins and worktree hooks.

After receiving updates:

```sh
yadm pull
yadm bootstrap
```

## Worktrunk

Never edit the generated `~/.config/worktrunk/config.toml` or the selected
`base.toml` copy. Edit the tracked profile source instead:

```sh
# Default installation
$EDITOR ~/.config/worktrunk/base.toml##default

# Work installation
$EDITOR ~/.config/worktrunk/base.toml##class.Work

~/.config/yadm/scripts/generate-worktrunk-config --dry-run
~/.config/yadm/scripts/generate-worktrunk-config
wt config show
```

The default profile generates its portable base. The Work profile composes the
EX fragment, Work base, and Depot fragment in that order.

## Orca

Orca (the desktop ADE) is configured from the `ex` submodule's tracked project
manifest, not from yadm directly — this repository is public, so no internal
repo names, paths, or hook scripts live here. `yadm bootstrap` reconciles a
running Orca on a Work machine, whether or not Orca itself runs there (its CLI
bridge reaches a paired Orca app over the same connection this shell already
uses for everything else).

To run it outside bootstrap, or to preview it:

```sh
~/.agents/plugins/ex/contrib/orca/configure.sh            # apply, then report the rest
~/.agents/plugins/ex/contrib/orca/configure.sh --check    # read-only; exits nonzero on drift
~/.agents/plugins/ex/contrib/orca/configure.sh --dry-run  # report without changing anything
```

Workspace location is applied automatically. Repository Setup/Archive hooks,
per-agent Command Overrides, and "Nest Workspaces" have no `orca` CLI setter,
so the script reports the exact values needed and where to paste them rather
than pretending an unattended path exists where none does. Edit the manifest
in the `ex` submodule to add or change a project.

## Diagnostics

Run the read-only doctor after setup or when troubleshooting:

```sh
~/.config/yadm/scripts/doctor
```

It reports the selected profile, required commands, Worktrunk freshness, Work
submodules, Orca configuration drift, Herdr integration status, and OpenCode
dependency state.

## Local State

Application-managed state remains outside yadm, including Claude/Codex sessions,
Herdr integrations, OpenCode dependencies, generated Worktrunk configuration,
Orca's own settings store, and Codex system skills. Credentials, SSH keys, AWS
configuration, GitLab/Jira authentication, and other secrets are never tracked.
