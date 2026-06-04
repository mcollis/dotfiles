#!/bin/bash
# PreToolUse hook: block commits whose message contains a Co-Authored-By
# footer. Filtered by "if": "Bash(git commit *)" — only runs on git commit.

COMMAND=$(cat | jq -r '.tool_input.command // empty')

if echo "$COMMAND" | grep -q 'Co-Authored-By'; then
    echo "Commit message contains a Co-Authored-By footer." >&2
    echo "Use the commit-message skill (/commit-message) to draft the message instead." >&2
    exit 2
fi
