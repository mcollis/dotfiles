#!/usr/bin/env bash
pane_path=$(tmux display-message -p '#{pane_current_path}')
branch=$(git -C "$pane_path" branch --show-current 2>/dev/null)
if [ -n "$branch" ]; then
    ticket=$(printf '%s' "$branch" | grep -oiE '(ex|oz)-[0-9]+' | head -1 | tr 'a-z' 'A-Z')
    tmux set-option -w @wl "${ticket:-$branch}"
else
    tmux set-option -wu @wl
fi
