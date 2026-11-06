# Configuration and setup

Nothing user-specific lives in this skill. Locations follow XDG and can be overridden.

| What | Default | Override |
|---|---|---|
| User config (hand-edited; safe to keep in a dotfile manager) | `~/.config/workflow-retrospective/config.json` | `WORKFLOW_RETROSPECTIVE_CONFIG_DIR` |
| Machine-local state (machine id, environment cache, outbox, locks); do not track | `~/.local/state/workflow-retrospective/` | `WORKFLOW_RETROSPECTIVE_STATE_DIR` |

## config.json

All keys are optional; values below are the defaults except `persistence`.

```json
{
  "sources": {
    "opencode": {"enabled": "auto", "command": "opencode"},
    "claude":   {"enabled": "auto", "root": "~/.claude/projects"},
    "codex":    {"enabled": "auto", "root": "~/.codex/sessions"}
  },
  "default_window_days": 30,
  "limits": {"max_sessions_per_batch": 25, "max_chars_per_turn": 1200, "max_chars_per_session": 24000,
             "warn_record_bytes": 1048576, "max_record_bytes": 26214400},
  "privacy": {"deny_terms": [], "deny_patterns": []},
  "instruction_paths": [],
  "skill_paths": [],
  "persistence": {"backend": "gitlab-snippet", "host": "gitlab.example.com", "title": "workflow-retrospective"}
}
```

Set `"enabled": false` to skip a source. Put organization, product, customer, and repository names in `privacy.deny_terms` so they can never be persisted. `instruction_paths` and `skill_paths` add locations to discovery.

## Persistence

The built-in backend is `gitlab-snippet`: one **private** personal snippet holding `workflow-retrospective.json` and `.md`.

- Reads and listing use your ambient, normally read-only GitLab credentials (`glab`).
- Updates are `git push` (no force) to the snippet's repository over your configured SSH/HTTPS git access; no API token is involved.
- `persist.py init --confirmed` creates the snippet once. It is the only operation that uses `glab`'s stored write credentials, so it needs your explicit approval and your agent instructions must permit that credential fallback for this one operation. Initialize interactively before any headless run, so runs never race to create it.
- The adapter never changes visibility. A non-private or duplicate-titled snippet stops the run.
- The record can grow; `max_record_bytes` refuses a save rather than dropping data. The server's own snippet size limit may be lower than GitLab's 50 MiB default.

To add another backend, implement the same operations as `GitLabSnippetStore` in `persist.py` (`lookup/read/save/create` with visibility verification, non-overwriting concurrent updates, and an outbox on failure) and select it with `persistence.backend`.

## Headless runs

Schedule `workflow-retrospective` in headless mode only after `persist.py status` shows the record exists and a manual save has succeeded. The run needs an agent mode allowed to run `collect.py`, `record.py`, and `persist.py save`, and must not be given edit access to skills or instructions. It starts by running `persist.py flush`. It never prompts; ambiguity is saved as open questions.
