#!/usr/bin/env bash
pane_path=$(tmux display-message -p '#{pane_current_path}')
branch=$(git -C "$pane_path" branch --show-current 2>/dev/null)
if [ -n "$branch" ]; then
    tmux set-option -w @wl "$branch"
else
    tmux set-option -wu @wl
fi
