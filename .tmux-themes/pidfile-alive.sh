#!/usr/bin/env bash
# Print a marker when the pid in $1 is alive. Empty otherwise.
# Generic: tmux invokes this with whatever pidfile path it has stored;
# this script knows nothing about webpack or any specific service.

PIDFILE="${1:-}"
MARKER="${2:-●}"

[ -z "$PIDFILE" ] && exit 0
[ ! -f "$PIDFILE" ] && exit 0

PID=$(cat "$PIDFILE" 2>/dev/null)
[ -z "$PID" ] && exit 0

if kill -0 "$PID" 2>/dev/null; then
    printf '%s' "$MARKER"
fi
