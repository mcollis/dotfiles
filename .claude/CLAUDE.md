# Response Style

Be concise: aim for ~4 lines of prose. Bullets, short headers, and inline code are fine — and preferred — when they make a multi-part answer scannable (status checks, requirement audits, before/after). Skip filler like "More on:" footers or restating the question. When prose would balloon past ~10 lines, ask before expanding.

# Confidence

Distinguish verified facts from guesses in your responses. For any factual claim about code, commands, flags, APIs, file paths, or behavior:

- **[verified]** — confirmed this turn by running a command, reading the file, or fetching docs. Name the source inline (e.g. `[verified: --help]`, `[verified: src/foo.ts:42]`, `[verified: git log]`).
- **[unverified]** — recalled from memory, earlier in the session, or training data without re-checking this turn.
- **[guess]** — inference or pattern-matching, not grounded in a specific source.

Rules:
- Before recommending an action (edit, command, config change, MR merge), verify the claims it depends on. Don't act on **[unverified]** or **[guess]**.
- If verification isn't possible, say so explicitly and explain why — don't silently drop the tag.
- Prose and opinions ("this looks reasonable", "I'd suggest X") don't need tags. Factual assertions do.
- A response that recommends an action with zero **[verified]** tags is a bug — stop and verify first.

# Tools

- Use `ast-grep` (installed at `~/.local/bin/ast-grep`; the `sg` alias collides with system `setgroups`, so always invoke `ast-grep`) for **structural code search and codemods** — anything matching syntax, not just text. Prefer it over `grep`/`rg` when searching for code patterns, call sites, JSX/props, or doing find-and-replace rewrites; it is AST-aware (skips comments/strings/imports) and metavariable-capturing.
  - Search: `ast-grep run -p 'useEffect($$$ARGS)' -l tsx <path>`. Languages don't stack on one `-l`; run per-language (`-l ts`, then `-l tsx`) and combine. `--json=compact` for machine-readable output.
  - Codemod (preview): `ast-grep run -p 'useState($INIT)' -r 'useState(() => $INIT)' -l tsx <path>` prints a diff and writes nothing; add `-U` to apply. Always review the preview before `-U`.
  - Still use `rg` for plain-text/non-code matches (logs, config, prose, quick literal greps) — it's faster and sufficient there. ast-grep earns its keep on multiline, structural, and rewrite work.
- Use `glab` CLI for all GitLab operations. **Always prefer `glab` over curling the GitLab API.** Only fall back to `curl` if `glab` genuinely cannot do what's needed. Default project: `core/depot`. Always pass `-R "https://gitlab.i.extrahop.com/<project-path>"`. Auth via `GITLAB_TOKEN` env var.
  - To resolve project from a URL: `https://gitlab.i.extrahop.com/core/hsm-automation/-/merge_requests/51` → `-R "https://gitlab.i.extrahop.com/core/hsm-automation"`, MR `51`
  - Use `glab mr note list` for MR comments/discussions — do NOT curl the API. Supports `--state unresolved`, `--type diff`, `--file <path>`, `-F json`.
- Use `jira-cli` for all Jira operations (server: jira.i.extrahop.com, project: EX, board: Team Discovery Channel).
  - `jira-cli issue view` does NOT show fixVersion. Use: `jira-cli issue view EX-12345 --raw 2>/dev/null | python3 -c "import sys,json; versions=json.load(sys.stdin)['fields']['fixVersions']; [print(v['name']) for v in versions]"`
  - fixVersion format is `YY.Q-CodeName` (e.g. `26.3-Underdog`) → release branch `release/<lowercase codename>`
  - Use `--plain` for non-interactive output (`--no-truncate` is NOT a valid flag)
- Use `wt` (worktrunk) for git worktree management in the bare repos (`depot.git`, `updates.git`). Config: `~/.config/worktrunk/config.toml`. This REPLACES the deprecated `worktree-create`/`worktree-open` skills.
  - Create a worktree: `wt ex EX-12345` (alias → `wt switch --create --no-cd user/$USER/EX-12345`; add `--base=<branch>` for a non-default base). Resume an existing one: `wt switch user/<name>/EX-12345`. List: `wt list`.
  - Run `wt` from the bare repo or any worktree. `wt ex` uses `--no-cd` and a `post-switch` hook to open/focus a tmux window in the worktree rather than cd-ing the shell.
  - Pruning and `.claude` push-back sync stay as skills: `/ex:worktree-prune` and `/ex:worktree-claude-sync` (worktrunk has no Jira/GitLab/Docker awareness). Landing a ticket is still push + GitLab MR (NOT `wt merge`, which merges locally and bypasses review).

# Permissions

- Destructive or external-visible operations should always prompt the user. Specific rules live in `settings.json` (`permissions.ask` / `permissions.deny`); when in doubt, ask before acting.
- Compound shell pipelines (`A && B && C`) can evade per-verb rules. Run gated verbs as standalone commands so the harness prompt fires.

# Git

- **Never include `Co-Authored-By` lines in commits.** This overrides the default commit template.
