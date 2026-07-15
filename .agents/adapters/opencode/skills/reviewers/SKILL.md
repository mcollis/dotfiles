---
name: reviewers
description: Use when the user asks who should review a merge request, or wants to pick reviewers for the current branch's MR. Ranks reviewer candidates by domain expertise on the changed files plus the user's recent reviewer history.
---

# Picking MR Reviewers

Produce a ranked shortlist (default: 5) of reviewers for the MR on the current branch, combining two signals: domain expertise on the changed files, and trusted collaborators from the user's recent reviewer history.

## Instructions

### 1. Run the discovery script

```bash
/home/michaelco/.claude/plugins/ex/skills/reviewers/run.sh
```

The script is read-only and outputs a structured report with these sections:

- **PROJECT / BRANCH / AUTHOR** — resolved context
- **MR** — IID, title, target branch, and full description (scan the description for hints like "mirrors the X page" or "ports onto Y later in EX-…")
- **CHANGED PATHS** — files in this MR vs. its target branch
- **DOMAIN EXPERTS** — `count | name` from git log on changed paths. Window is 1 year, auto-widens to 2 years if sparse (top author < 5 commits). Already excludes the MR author.
- **RECENT ACTIVITY (3 months)** — authors who've touched these paths recently. Anyone on the DOMAIN EXPERTS list but NOT here should be flagged as "possibly unavailable".
- **AUTHOR → USERNAME MAP** — `display name|username` derived from commit emails, for mapping git-log names to GitLab usernames.
- **TRUSTED COLLABORATORS** — `count | username` tally of reviewers on the user's 10 most recent merged MRs.

### 2. If the MR description hints at a mirrored/template pattern

If the description says the change mirrors, generalizes, or extracts from an existing component (e.g., "mirrors the existing Netskope page"), run one extra `git log` on that template's path — its authors have the sharpest context on the abstraction:

```bash
git log --since="2 years ago" --format='%an' -- <template_path> | sort | uniq -c | sort -rn
```

### 3. Rank and present

Produce a short table: `Reviewer | specific rationale`. Each rationale must cite concrete signal from the report — "X commits in \<dir\>", "co-authored the template", "reviewed Y/Z of your recent MRs". Prefer reviewers who appear on BOTH the domain-experts list and the trusted-collaborators list. Flag any top pick missing from RECENT ACTIVITY as possibly unavailable.

End with 1 honorable-mention swap-in candidate, then ask if the user wants them assigned on the MR.

## Gotchas

- `approvals_before_merge` is often empty — use reviewers as the proxy for engagement.
- Don't over-weight heavy committers who never review. The user wants people who will actually engage.
- If no MR exists yet (branch not pushed), the script still reports domain experts based on `HEAD~1` fallback — note this in the recommendation.
