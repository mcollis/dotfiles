#!/usr/bin/env bash
# Push Claude state into tmux window variable.
# Usage: claude-notify.sh {waiting|clear}
[ -z "${TMUX:-}" ] && exit 0
# Target THIS Claude's pane (-t $TMUX_PANE), not tmux's current window — otherwise a
# window switch between waiting/clear (e.g. `wt` opening a new window) strands the flag
# on the wrong window. Claude exposes $TMUX_PANE to hooks.
TARGET=${TMUX_PANE:+-t "$TMUX_PANE"}
case "${1:-}" in
  waiting) tmux set-option $TARGET -w @claude-waiting "💬" 2>/dev/null ;;
  clear)   tmux set-option $TARGET -wu @claude-waiting 2>/dev/null ;;
esac
