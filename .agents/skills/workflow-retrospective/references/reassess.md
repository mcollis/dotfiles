# Reassess: what happened to previous findings

Runs after scope and before looking for new problems, in interactive and headless mode alike. It keeps the report current without asking the user to maintain statuses or report back. It records what was observed; it never records a decision.

## Inputs

- Findings in `open`, `deferred`, `planned`, or `implemented` state (skip `dismissed` and `validated` unless something recurs).
- `environment.py skills`: each target's current `hash` and `modified` versus the finding's `target_rev`. Read the canonical source, never a generated copy.
- The sessions `record.py plan` already selected. Do not scan history a second time.

## Method

Start cheap, go deep only where something changed or the evidence conflicts.

1. **Did the target change?** Compare its hash with `target_rev`. If it changed, read the new content and check whether it does what the finding's proposal intended.
2. **Was the target exercised since?** Among the planned sessions, find ones dated after the finding's last assessment or state change that involved the target (skill loaded, workflow performed). When analysts are used, give each a compact list of active findings (`id`, one line, target) and ask for per-finding sightings in the same pass. Spawn a guidance investigator only when verifying target content is itself large.
3. **Decide the status.**

| Status | Record it when |
|---|---|
| `still_issue` | The same friction appears in a session dated after the finding's last assessment or state change. Attach that session as evidence. |
| `implemented` | The target's current content shows the intended change, verified by reading it. A commit, a handoff, or a receiving agent's report is a lead to verify, not proof. |
| `improvement_observed` | One or more sessions exercised the changed target afterwards without the friction repeating. Attach them as evidence and state how many. Never write "fixed". |
| `needs_correction` | The cause was wrong, overstated, duplicated, or superseded, which you can show from current guidance or transcripts. |
| `unknown` | Relevant evidence is missing. Write this only when it is new information; an unchanged assessment is skipped by the merge. |

## Rules

- If nothing new was learned about a finding, write no assessment. Silence is not improvement, and a changed file is not an effective fix.
- Assessments never change `state`, never dismiss or validate a finding, and never authorize work. `validated` and `dismissed` remain the user's decisions, and the user is not asked to confirm routine progress.
- A `still_issue` with evidence dated after an `implemented` or `validated` state is surfaced as a recurrence automatically.
- When evidence answers a stored question, list that question verbatim in `answered_questions` so it is cleared and remembered. Do not delete questions otherwise.
- Update `target_rev` on the assessment when you re-read a changed target.
- A diagnosis that was wrong is corrected through `needs_correction` plus a revised `summary`/`cause`/`proposal` on the finding (allowed while it is `open` or `deferred`); history stays.
- Notes follow the same sanitization rules as findings.

## Output

An `assessments` list in the delta (`record.md`), saved before new discoveries so a stopped run loses nothing:

```json
{"id": "f-<key>", "status": "improvement_observed", "confidence": "medium",
 "note": "<sanitized: what was observed and how many sessions>",
 "at": "<ISO time of the newest evidence>", "target_rev": "<hash>",
 "evidence": [{"sid": "<16 hex>", "note": "<sanitized>", "at": "<ISO>"}],
 "answered_questions": ["<question text as stored>"]}
```

The report then leads with "Changed since the previous review", moves observed implementations to "awaiting validation", and lists corrected diagnoses separately.
