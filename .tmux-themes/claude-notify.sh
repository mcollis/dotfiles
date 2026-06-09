#!/usr/bin/env bash
# Push Claude state into tmux window variable.
# Usage: claude-notify.sh {waiting|clear}
[ -z "${TMUX:-}" ] && exit 0
case "${1:-}" in
  waiting) tmux set-option -w @claude-waiting "💬" 2>/dev/null ;;
  clear)   tmux set-option -wu @claude-waiting 2>/dev/null ;;
esac
