# Planning: from selected finding to decision-complete handoff

Planning decides; execution follows. Resolve substantive decisions by investigating or asking the user — never leave them to whoever executes. How planning and execution are split between models/agents comes from the user's profile; if none is recorded, produce the handoff and stop.

For each selected finding:

1. **Re-verify the cause** against the canonical source, at its current content (`environment.py skills` hash vs the finding's `target_rev`). If the situation changed, say so and revise the finding.
2. **Choose the smallest effective change** (order in `analysis.md`). Reuse existing patterns and files; justify any new skill or script.
3. **Resolve ambiguities** with the user: behavior, scope, naming, edge cases. Ask one decision at a time; recommend an option.
4. **Check blast radius**: other skills or instructions that reference the target, generated or synchronized copies of it, other harnesses that load it, who owns each layer.
5. **Decide verification**: the minimum check that would show the problem is fixed, and the signal in future sessions that would validate it.

## Handoff

- **Objective** and the sanitized problem it addresses
- **Exact changes**: file or area, what changes, what stays the same, existing component to reuse
- **Exclusions**: what must not be touched
- **Authorization**: which actions are authorized (edits, checks, commits, pushes) — and that the plan itself grants none of them
- **Verification**: named checks and expected results
- **Return to planning if**: the files don't match, a new abstraction or behavior is needed, or scope changes

Save the outcome as a decision (`planned`). Do not wait for a completion report: the next run's reassessment records `implemented` and later `improvement_observed` from what it can verify. An agent that completes a handoff may record `implemented` as an assessment, never as a decision. `validated` stays the user's decision.
