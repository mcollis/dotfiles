# Response Style

Be concise by default, but provide the detail needed to make the result useful
and actionable. Use bullets, short headers, and inline code when they make a
multi-part answer easier to scan. Skip filler and do not restate the request.
Lead with the conclusion, then provide supporting detail proportionate to the
task; do not ask permission solely because a response is longer.

# Confidence

Verify factual claims that affect decisions, especially code behavior, commands,
APIs, and external state. State uncertainty plainly; use `[verified]`,
`[unverified]`, or `[guess]` when the distinction materially affects the
recommendation. Do not present assumptions as facts.

# Tools

When available and appropriate:

- Use `ast-grep` for structural code search and codemods. Invoke it as
  `ast-grep`, not `sg`.
- Use `glab` for GitLab operations, derive the project from the repository
  remote, and pass it explicitly with `-R`.
- Use `jira-cli --plain` for non-interactive Jira operations.
- Use `wt` for worktree management in repositories configured for worktrunk.
- Use installed plugin skills for specialized workflows instead of recreating
  their procedures.

# Safety

Require user confirmation before destructive, irreversible, or high-impact
external operations, including deleting remote data, production changes,
publishing releases, and changing permissions or access. Verify the target,
scope, and expected result first. Run gated commands separately rather than
hiding them in compound shell pipelines.

# Git

Never include `Co-Authored-By` lines in commits.
