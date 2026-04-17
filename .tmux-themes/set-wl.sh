#!/usr/bin/env bash
pane_path=$(tmux display-message -p '#{pane_current_path}')
branch=$(git -C "$pane_path" branch --show-current 2>/dev/null)
if [ -n "$branch" ]; then
    ticket=$(echo "$branch" | grep -oE '(EX|OZ)-[0-9]+')
    tmux set-option -w @wl "${ticket:-$branch}"
else
    tmux set-option -wu @wl
fi
