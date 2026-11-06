# Orchestration: freshness and delegation

The main agent owns scope, the profile, deduplication, user discussion, persistence, and every decision. Workers are read-only investigators with one bounded question each. Do not delegate a stage just because it exists; delegate when independent work shrinks context or latency.

## Freshness

Judge by evidence and relevance, not age. Check only what this run touches.

| Item | Stale when | Action |
|---|---|---|
| Confirmed preference | the user contradicts it | ask once, update |
| Tentative preference | contradicted or never re-observed | keep, lower weight, or drop quietly |
| Environment fact | `environment.py check` lists it, or a command contradicts it | rediscover |
| Skill/instruction assessment | the target's `hash` differs from the finding's `target_rev`, or new sessions show different behavior | reassess before presenting |
| Finding `planned` or `implemented`, or any finding whose target changed | `reassess.md` applies (target hash differs from `target_rev`, or sessions exercising the target now exist) | reassess; record an assessment, never a decision |
| Coverage | `record.py plan` shows new sessions, new activity in old sessions, or holes | review the gap |

Mention a consequential routing choice in one line ("this assessment predates a change to the skill, so I'm rechecking it"). Do not narrate every step.

## When to delegate

| Situation | Do |
|---|---|
| Focused review, or ≲ 8 sessions to examine | work directly |
| Larger review | **transcript analysts**: batches of ~8 sessions each, at most 4 concurrent |
| Profile/environment missing or contradicted | **environment investigator** (read-only; reports facts with evidence) |
| A finding hinges on what a skill or instruction actually says or does | **guidance investigator** (reads canonical sources and current hash) |
| Repeated manual work suggests a reusable workflow | **workflow investigator** (checks recurrence and sameness across sessions) |
| A selected improvement is risky or uncertain | **plan challenger** (tries to falsify the plan) |

Worker roles are prompts, not registered skills. Never spawn one per module.

## Worker brief

Give each worker: the question; the exact sessions (`source`, `ref`, `after_ms`) or files; only the relevant profile entries; the evidence standard from `analysis.md`; a compact list of active findings (`id`, one line, target) so it also reports per-finding sightings or absences for `reassess.md`; and this contract.

- Read-only. Use `collect.py read` for transcripts. Do not write files, persist anything, edit the profile, or make decisions.
- Return a compact JSON list of candidates: `{sid, class, category, impact, confidence, target, note, counter_evidence?, uncertainty}`, plus `sightings`: `{finding_id, sid, kind: still_issue|ran_cleanly, note}` for the findings you were given. Notes are already generalized: no quotations, identifiers, paths, URLs.
- State what was not examined and why.

## Reconcile

- Deduplicate by cause and target; combine equivalent candidates before they become findings.
- Verify every high-impact claim and every claim a recommendation depends on by reading the episode yourself.
- Preserve disagreement as a question on the finding rather than forcing agreement.
- Stop investigating when the headline set stops changing. Coverage of what remains is recorded as partial, never implied complete.
