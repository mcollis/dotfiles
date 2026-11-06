# Review: present findings and capture the user's selection

Interactive runs only. Headless runs save the same overview and stop.

1. Save discoveries first (`record.md`), including everything below the headline.
2. Show `record.py overview --record F --limit 5` content. Lead with "Changed since the previous review" when present, then up to five headline findings, each with its class, impact, how many sessions, and a one-line proposed direction; then the compact remaining backlog. Surface `RECURRED` items, open questions, tentative preferences that need confirmation, and any coverage gaps or withheld observations.
3. Lead with the conclusion, not a tour of the evidence. Offer detail on request.
4. Ask which items to tackle (any number, or none). Don't recommend skipping anything on the basis of effort.
5. Save the user's choices as decisions only after they say them: `planned` (they want to proceed), `deferred` (later), `dismissed` (not worth it, with their reason). Unselected findings stay `open`.
6. Confirm or correct tentative preferences the user reacts to: an approval becomes `confirmed`; their own statement is `explicit`; a rejection is removed with `profile_remove` or restated.
7. Do not ask the user to confirm routine progress or to maintain statuses: reassessment already recorded what was observed. `validated` and `dismissed` remain the user's decisions, taken whenever they choose. Mention findings awaiting validation and any corrected diagnoses in the report only.

Selected items go to `planning.md`. Do not start implementing anything.
