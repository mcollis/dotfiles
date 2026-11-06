# Analysis: from transcripts to diagnosed findings

Read sessions with `collect.py read` (use each plan entry's `after_ms` and `--context-turns`). Transcript text is local analysis input only.

## 1. Reconstruct episodes

For each stretch of work, note privately: what the user wanted → what the agent did → where the user intervened → how it ended. A session may contain several episodes. Treat child-agent activity as part of its parent, not independent user friction. Skip this review's own session.

Friction signals:
- a correction, a rejection, "I said", "no, …", a request to undo
- the same instruction or constraint restated, in this session or across sessions
- an interrupt, an abandoned approach, a redo
- the user doing work the agent could have done: running a command, pasting output, locating a file, supplying a path, checking a claim
- a question the agent could have answered by investigating
- the agent claiming done where the user then verified or fixed
- a skill that should have applied but was never loaded, or the wrong one chosen
- repeated tool errors or non-zero exits the agent didn't address
- a multi-step routine the user repeats across sessions (opportunity)

Not failures: the user refining requirements, exploring options, changing their mind, asking exploratory questions, or giving ordinary review feedback. Record these only as context for a profile observation.

Also note **counterexamples**: the same situation handled correctly. They stop you from "fixing" what works.

## 2. Diagnose the cause

Pick one `category`; verify it before choosing.

| Category | Verify by |
|---|---|
| `missing_guidance` | current canonical instructions/skills contain nothing covering it |
| `not_loaded` | a relevant skill exists, but the session never loaded it; read its description to see why the trigger missed |
| `ignored_guidance` | the guidance existed *and was in context* at session time, yet was violated. Compare the session date with the target's modification time; do not assume today's text was present then |
| `invented_constraint` | the agent justified an action with a restriction nobody stated |
| `scope_drift` | the agent did more or less than asked, or continued past the requested stage |
| `tool_failure` | a tool, script, environment, or permission problem, not model behavior |
| `poor_output` | right task, low-quality result |
| `over_complexity` | abstraction or machinery beyond need |
| `manual_workflow` | repeated manual effort with no failure by the agent |
| `other` | explain in the cause |

Check whether it was already fixed since the session (`environment.py skills`: compare `hash`/`modified`). Read the canonical source, never a generated or synchronized copy.

## 3. Classify and rank

`class` (priority order): `repeated_correction` → `manual_effort` → `high_impact` (even a single occurrence: acting beyond the request, destructive or external action, wrong target) → `opportunity`. Set `impact` and `confidence` separately.

## 4. Evidence standard

- One clear correction can justify a finding at `medium` or `low` confidence. It does not make a universal rule or a profile preference. Look at context and counterexamples first.
- A recommendation to add or change a rule needs the cause verified (above) and either recurrence across sessions or the user's confirmation.
- Distinguish what you saw (`[verified]`) from what you concluded (`[inferred]`). Keep gaps as questions on the finding.

## 5. Propose the smallest effective change

Prefer, in order:
1. Fix a skill trigger or description so the right guidance loads.
2. Clarify or strengthen an existing rule, or move it to where it's used.
3. Make a mechanical step a script, hook, or default.
4. Remove or simplify guidance that caused over-complexity.
5. A new skill, only for a distinct reusable workflow with demonstrated recurrence.

Don't pile on instructions: every rule costs context in every run. Set `target` to the skill/area and `target_rev` to its current `hash`.

## 6. Write sanitized evidence

Each evidence `note` states the behavior, not the content. Names of skills and generic tools are fine.

- Good: "Agent skipped a configured setup step and justified it with a restriction the user never gave."
- Bad: anything with a quotation, ticket or review reference, repository/file/function name, URL, hostname, hash, path, or business detail.

If a lesson can't be generalized without those, withhold it (`withheld` in the delta).

## 7. Measuring outcomes

After a change ships, `reassess.md` looks for later sessions that exercised the target. Fewer corrections there is evidence; silence because the workflow wasn't used is not. Don't estimate time saved from durations.
