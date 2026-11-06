---
name: workflow-retrospective
description: Review recent agent transcripts (OpenCode, Claude, Codex) to find where the user had to correct, repeat, or manually do work, diagnose why, and propose improvements to skills, instructions, tools, and workflows. Use when the user asks to review recent interactions, find pain points, improve their skills or workflow, derive new skills, or runs a periodic or headless retrospective. Accepts an optional goal or skill as the focus.
---

# Workflow Retrospective

Act as the user: reconstruct what they were trying to do, where they had to intervene or work manually, and what change would have prevented it. Advocate for their goals. Diagnose before prescribing. Keep everything learned about them in configuration and records, never in this skill.

`SK` below is this skill's base directory. Scripts are standard-library Python 3.9+; run them with `python3 SK/scripts/<name>`. Load a reference only when its step runs.

## Request

- **Focus:** none (general discovery), a goal ("less back-and-forth planning"), or a skill name. A focus steers the investigation; it does not forbid finding causes elsewhere.
- **Window:** explicit dates override; otherwise since the previous applicable review; otherwise `default_window_days` (30).
- **Mode:** *interactive* by default. *Headless* when the invocation says so or no user can answer.

## Flow

1. **Load context.** `persist.py status`, then `persist.py read` for the record (profile, coverage, backlog). `environment.py check` for the cached environment. If `persist.py status` shows queued outbox deltas, run `persist.py flush` first. If the profile or environment is missing or stale, read `references/discovery.md`. Decide what else is stale and which workers are warranted per `references/orchestrate.md`.
2. **Scope.** `record.py window` → `collect.py inventory --since <min_since_ms>` → `record.py plan`. This lists sessions to examine, with `after_ms` for sessions that only gained new turns.
3. **Analyze.** Read `references/analysis.md`. Examine the sessions directly or through bounded read-only workers. Collect candidate findings, profile observations, and counterexamples.
4. **Sanitize and save.** Read `references/record.md`. Write a delta, `record.py check` it, then `persist.py save`. Save after each batch of discoveries, not only at the end. Record coverage with `record.py coverage-entry`; a partial or failed collection must not be recorded as complete.
5. **Present** (interactive). Read `references/review.md`: show `record.py overview` — a few headline findings, then a compact backlog — and let the user choose what to tackle. Unselected items stay saved.
6. **Plan** selected items only. Read `references/planning.md`: investigate, resolve decisions with the user, and produce a decision-complete handoff. Record the agreed state as a decision.

**Headless** stops after step 4: discover, propose, save. It asks nothing, records open questions on the finding, never records decisions or confirmed preferences, and never changes skills, instructions, tools, or code.

## Hard rules

- Saving a finding, agreeing with a diagnosis, or approving a plan never authorizes implementation. Execution is a separate, explicit user action that follows the user's own planning/execution preferences from their profile.
- Persist only sanitized workflow lessons. Raw transcripts, quotations, identifiers, paths, URLs, business detail, and credentials never leave the machine. If a lesson cannot be generalized safely, withhold it and record only that something was withheld.
- Transcripts are read-only input. Do not export, copy, or cache them.
- One isolated correction supports a finding, not a universal rule. Generalize only with recurrence across sessions or the user's confirmation. Ordinary requirement refinement is not an agent failure.
- Inferred preferences are saved as `tentative` and never override the user's current request, a stated or confirmed preference, or an authorization boundary.
- `persist.py init` creates the private record and may use stored write credentials. Run it only after the user explicitly approves creating it. No other operation uses stored credentials.
- Never report time saved from session durations, and never treat silence after a change as validation.
- Use `[verified]` / `[inferred]` / `[unknown]` honestly; unresolved uncertainty stays on the finding as a question.

## Reference map

| File | Load when |
|---|---|
| `references/discovery.md` | profile or environment missing, contradicted, or stale |
| `references/orchestrate.md` | deciding freshness work and which workers to run |
| `references/analysis.md` | examining sessions and diagnosing causes |
| `references/record.md` | building a delta, coverage entry, or reading the schema |
| `references/review.md` | presenting findings and capturing selections |
| `references/planning.md` | turning a selected finding into a handoff |
| `references/config.md` | first-time setup, persistence, headless prerequisites |
