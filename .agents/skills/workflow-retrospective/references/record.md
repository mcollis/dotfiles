# Record: schema, deltas, commands

The record is one JSON document (plus a rendered Markdown overview) in the configured private store. Everything in it is sanitized. Never edit it by hand or write it directly: build a **delta**, `check` it, and let `persist.py save` merge it deterministically. Unknown schema versions need reconciliation by the user/Plan.

## Sections

- `profile.entries[]`: `id, text, scope, status (explicit|confirmed|tentative), rationale, observations, contradictions[]`
- `coverage[]`: per `source` + `machine` + `scope` (`general` or `focus`+text): `from_ms, to_ms, complete, sessions{sid: updated_ms}` (partial only), `gaps[]`
- `findings[]`: `id, title, summary, class, category, impact, confidence, cause, proposal, target, target_rev, state, sids[], recurrence, evidence[], counter_evidence[], questions[], decisions[]`, plus `recurred_after_resolution`, and once reassessed: `assessment` (latest), `assessments[]` (last 10), `resolved_questions[]`
- `reviews[]`: brief log of runs (`id, kind, focus, summary, counts`)
- `withheld`: count and generic classes of observations omitted for privacy

States: `open, deferred, planned, implemented, validated, dismissed`.

## Delta

```json
{
  "review":   {"id": "r-2026-11", "kind": "general", "summary": "first monthly pass"},
  "coverage": [ <output of record.py coverage-entry> ],
  "profile":  [{"id": "concise-answers", "text": "...", "scope": "global", "status": "tentative", "rationale": "..."}],
  "findings": [{
    "key": "skipped-configured-setup", "title": "...", "summary": "...",
    "class": "high_impact", "category": "invented_constraint", "impact": "high", "confidence": "medium",
    "cause": "...", "proposal": "...", "target": "worktree-creation", "target_rev": "<hash>",
    "evidence": [{"sid": "<16 hex from inventory>", "note": "<sanitized>", "at": "<ISO time of the episode>"}],
    "counter_evidence": [], "questions": []
  }],
  "assessments": [{"id": "f-skipped-configured-setup", "status": "improvement_observed", "confidence": "medium",
                   "note": "<sanitized>", "at": "<ISO time of the newest evidence>",
                   "evidence": [{"sid": "<16 hex>", "note": "<sanitized>", "at": "<ISO>"}],
                   "answered_questions": ["<stored question text>"]}],
  "decisions": [{"id": "f-skipped-configured-setup", "state": "planned", "note": "<sanitized>"}],
  "profile_remove": [],
  "withheld": [{"class": "business_detail"}]
}
```

- `key` becomes the id `f-<key>` (lowercase slug). Reuse the same key for the same finding so evidence accumulates; recurrence counts distinct `sid`s, so re-reviewing a session never inflates it.
- Resolved findings (`implemented`, `validated`, `dismissed`) keep their descriptive fields; later evidence dated after the resolution marks `recurred_after_resolution` and surfaces it. It does not reopen or dismiss.
- `assessments` record evidence-based progress (`still_issue | implemented | improvement_observed | needs_correction | unknown`, see `reassess.md`). They are allowed in headless mode, reference an existing finding, and never change its `state` or `decisions`. Evidence is allowed only for `still_issue` (counted as a new session, and surfaced as a recurrence if the finding is resolved) and `improvement_observed` (stored as counter-evidence). An unchanged or older assessment is skipped; `answered_questions` moves matching questions to `resolved_questions`.
- Save the `review` entry last in a run: "Changed since the previous review" is the assessments newer than the previous completed review.
- `decisions` and `profile_remove` are interactive-only and must reflect what the user actually said. Headless deltas may contain only `review`, `coverage`, `findings`, tentative `profile`, and `withheld`.
- Descriptive fields on `planned`/`implemented`/`validated`/`dismissed` findings are not overwritten by later deltas (reported as ignored).

## Commands

```
record.py window  --scope general|focus:<text> [--record F] [--since T]
collect.py inventory --since <min_since_ms from window>
record.py plan    --scope ... --record F --inventory inv.json     # sessions to examine, per source
record.py coverage-entry --plan plan.json --source S --reviewed sids.json [--gap TEXT]
record.py check   delta.json [--mode headless]                    # schema + privacy; exit 1 on problems
persist.py save   --delta delta.json [--mode headless]
record.py overview --record F [--limit 5]
```

`window` and `plan` take the record as a file; get it with `persist.py read > record.json`. Per-source `since` can differ; `window` reports each, and `plan` filters accordingly.

`coverage-entry` marks coverage `complete` only if the source was collected successfully and every planned session id appears in `--reviewed`; otherwise it records the reviewed subset so the next run resumes. Explicit date ranges extend coverage only if contiguous with existing coverage; `plan` reports holes. A focused review never advances general coverage; general coverage counts toward a focus.

## Privacy gate

`check` and `save` reject (rule names only, never the matched text): URLs, emails, ticket-style keys, review references, absolute or multi-segment paths, filenames, hostnames/IPs, commit hashes, credential patterns, code fences, long quotations, inline code that isn't a simple lowercase name, and anything matching `privacy.deny_terms` / `deny_patterns` from config. A passing check is necessary, not sufficient: re-read each note and ask whether a colleague could identify the work or the people. If so, rewrite or withhold. Rejected deltas are never queued.

## Failure handling

If a save fails, the sanitized delta is queued in the local outbox and the command reports `NOT SAVED`. Don't claim coverage advanced. `persist.py flush` retries queued deltas (re-checked first) at the start of the next run. Stop and report on duplicate or non-private snippets, incompatible schema, or exhausted conflict retries.
