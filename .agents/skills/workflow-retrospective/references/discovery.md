# Discovery: learn the user and environment once, then reuse it

Goal: know enough to advocate for this user without re-interviewing them every run. What you learn lives in the record's `profile` (shared, sanitized) and the machine-local environment cache — never in this skill.

## Load order

1. Profile: `persist.py read` → `profile.entries`. If persistence is not configured, read `config.md` and tell the user plainly that findings can be presented but not saved.
2. Environment: `environment.py check`. If there is no cache, or it reports `stale`, `new_facts`, or `vanished_facts`, run `environment.py discover --write` (read-only inspection) and use the diff.
3. Skills: `environment.py skills` when a finding or focus involves a skill. It gives each skill's canonical path, repository root, and content hash.

## What to establish

Infer from the environment and existing profile first. Ask only what is both consequential and not inferable; batch questions, at most three on a first run.

| Topic | Source | Ask only if |
|---|---|---|
| Transcript sources | `collect.py sources`, environment facts | a source is expected but unavailable |
| Where reviews are stored | `config.json` persistence | nothing is configured |
| Canonical vs generated instruction/skill files | `instruction_file` facts (`canonical`, `generated_from`, `managed_by`, `git_root`) | ownership is ambiguous; never propose edits to a generated copy |
| Instruction layers (global / organization / project) | instruction and skill-root facts, repository roots | layers overlap and you cannot tell which owns a rule |
| Privacy boundary | `config.json` `privacy.deny_terms` | the user has not named organization, product, or repository names to withhold |
| Planning vs execution split, authorization habits, communication style | profile; transcripts | never ask up front — infer as `tentative` and let the user confirm during review |

## Recording preferences

Each profile entry: `id` (slug), `text`, `scope` (where it applies), `status`, `rationale`.

- `explicit`: the user stated it. `confirmed`: the user approved a proposed entry. `tentative`: you inferred it from behavior.
- Keep scope narrow. "Slim tests on this ticket" is not "always minimize tests".
- A tentative entry that disagrees with an explicit or confirmed one is recorded as a contradiction on that entry, never an override. Surface contradictions when they affect a recommendation.
- Preferences describe how to help. They are never permission to act.
- Headless runs may only add or refresh `tentative` entries.

## Staleness of knowledge

Confirmed preferences stay valid until contradicted or changed by the user. Environment facts are refreshed by change, not age. Re-ask nothing the profile already answers.
