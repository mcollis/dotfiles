---
name: commit-message
description: Help draft a commit message from the current diff. TRIGGER when user asks to write, draft, or review a commit message, or asks to commit changes. Reads {repo-root}/.agents/conventions/commit-message.md if present and follows its rules; otherwise drafts a generic imperative-mood commit.
---

# Commit Message Helper

Draft a well-structured commit message based on the current diff. Reads the repo's conventions file for project-specific format (risk prefixes, ticket footer, etc.) if one exists, and falls back to generic git conventions otherwise.

## Instructions

1. Run `git diff --cached` (and `git diff` if nothing is staged) to review the changes.
2. Look for `{repo-root}/.agents/conventions/commit-message.md`. If it exists, read it and follow its rules. Treat it as authoritative for format, footer, and any project-specific prefixes.
3. Derive a ticket ID from the branch name using the generic pattern `[A-Z]+-[0-9]+` (e.g., `user/mike/EX-67574-foo` → `EX-67574`, `feature/FOO-123` → `FOO-123`). If `$TICKET_ID` is set in the shell (from .envrc), prefer it. If neither yields a ticket, ask the user.
4. Draft the commit message following (in order of preference):
    - The conventions file's format, if present
    - Generic imperative-mood style otherwise
5. Present the draft and ask for:
    - The ticket ID, if it couldn't be inferred
    - Any additional context about **why** the change was made
    - **If the conventions file defines a prefix/classification scheme (e.g., risk prefixes):** ask which to apply. NEVER auto-assign one — even if the diff looks "obviously safe" or "obviously risky". The choice belongs to the human author.
6. Present the final message for approval. Do NOT commit without explicit confirmation.

## Generic Format (when no conventions file exists)

```
<Imperative title, ~50 chars>

<Body explaining WHY, wrapped at 72 chars. Blank line between
paragraphs. Explain motivation, trade-offs, and decisions, not
what the diff obviously shows.>
```

- Title: imperative mood ("Add X" not "Added X"), capitalize first letter, no trailing period
- Body: wrap at 72 characters, separate paragraphs with blank lines, explain the why
- **Never** add `Co-Authored-By`, AI attribution, or any other generated footer unless the conventions file explicitly calls for one

## Drafting Style

Lessons from real drafting sessions — apply these when writing the body:

- **Lead with the user-visible symptom, not the internal mechanic.** "The popover was hidden behind the banner" beats "ancestor `overflow: hidden` clips the widget when Monaco flips it upward." Mention the mechanic only if the symptom alone is too vague to justify the fix.
- **Don't pad with common-sense statements.** Lines like "getting it wrong corrupts the query" or "these two need to agree" are filler — the reader already knows. Cut them.
- **A sentence of *what* is fine; avoid *how*.** "Expose helpers for reading, replacing, and stripping the sort clause" is useful. Listing function names or describing the parse/serialize flow is not, unless it's genuinely load-bearing context.
- **Cut sub-sentence "where" phrases too.** It's not just full *how* sentences — phrases like "in the AnchorHead endpoint and on each proxied request" or "in the auth middleware" tell the reader where in the code something happens. That's *how*, not *why*. They also invite tangential reviewer questions (perf, scope) that aren't the point of the commit. Heuristic: if a phrase points at code locations, cut it.
- **Default to the most general framing the change actually supports.** When the underlying capability is broader than the immediate trigger (e.g., "share state between dev servers" vs. "share state between worktrees"), frame the commit at the broader level. The trigger goes in the PR description if anywhere; the commit should describe the capability so future readers searching git log find it under the term they'd use.
- **Verify architectural claims before stating them.** Don't write "X's container" or "Y runs inside Z" from memory — get containment direction, ownership, and naming wrong and reviewers notice. A quick `docker inspect`, grep, or file read costs less than an amend.
- **Don't reference related tickets in the body** unless the user asks. The ticket footer is enough; cross-references rot.
- **Never use em dashes.** Use commas, colons, parentheses, or two sentences.
- **Prefer short bodies.** One tight paragraph usually beats two loose ones. Only add a second paragraph when there's genuinely separable content (e.g., "how sync works" vs. "why sort specifically").
- **Use plain language; drop the jargon.** Say "a Site cannot filter system objects," not "a Site selection cannot scope system-object queries." If you catch yourself bending a sentence to avoid repeating a noun (e.g. "all-system objects offers no filter"), just repeat the noun. State the cause and effect directly in the order a reader thinks about them; don't lead with the solution's framing ("Detect this from the data rather than by name: ...") before the plain fact.
- **Don't enumerate what the change leaves unaffected.** Isolation notes ("X, Y, Z are unchanged") belong in review or the PR description, not the commit body — the diff already shows the scope. State what changed and why, and let the absence speak for itself.

When the user pushes back, the fix is usually one of: remove a sentence, swap jargon for plain language, cut an isolation/unaffected note, or cut a reference to something outside this commit.

## Examples

**Good (generic):**
```
Guard DashboardGrid against empty widget lists

Earlier refactor assumed at least one widget; an empty dashboard
now renders a friendly placeholder instead of throwing at
ResizeObserver setup.
```

**Bad (don't do this):**
```
Fixed bug
Changed some files to fix the integration bug
```

## When Things Are Ambiguous

If the diff spans unrelated concerns, flag it and ask whether to:
- Split into multiple commits (preferred)
- Write a single message that accurately covers the combined scope

Don't paper over a multi-concern diff with a vague title.
