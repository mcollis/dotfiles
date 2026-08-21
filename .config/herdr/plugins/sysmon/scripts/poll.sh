#!/usr/bin/env bash
# poll.sh — pushes threshold-bucketed CPU/MEM tokens to the workspace
# labeled "~" only, colored via config.toml fg overrides per bucket.
# Works on Linux and macOS; see metrics.sh for the per-OS collectors.
#
# Modes:
#   --spawn  detach a long-running poller and exit (used by the plugin startup hook)
#   --run    run the poll loop in the foreground (also the detached child mode)
#   --stop   kill a running poller and clear the pidfile
#
# If no workspace is labeled "~", the poller logs and pushes nothing that
# cycle; it re-checks every cycle so renaming/creating "~" is picked up
# automatically without a restart.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Matches Herdr's own plugin_state_dir(plugin_id) formula so a manually
# started poller and a future Herdr-invoked startup hook always agree on
# one state directory, even though only the startup hook actually receives
# HERDR_PLUGIN_STATE_DIR from Herdr. Exported so metrics.sh's own
# ${HERDR_PLUGIN_STATE_DIR:-.} fallback (used for the Linux /proc/stat
# sample file) resolves here too, instead of defaulting to the caller's cwd.
DEFAULT_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/local.sysmon"
export HERDR_PLUGIN_STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$DEFAULT_STATE_DIR}"
STATE_DIR="$HERDR_PLUGIN_STATE_DIR"
mkdir -p "$STATE_DIR"
PIDFILE="$STATE_DIR/sysmon.pid"
LOGFILE="$STATE_DIR/sysmon.log"

HERDR="${HERDR_BIN_PATH:-herdr}"
CADENCE_SEC="${SYSMON_CADENCE_SEC:-5}"
SOURCE_ID="local-sysmon"
TARGET_LABEL="~"
TTL_MS=15000

# shellcheck source=metrics.sh
source "$SCRIPT_DIR/metrics.sh"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOGFILE"; }

target_workspace_id() {
  "$HERDR" workspace list 2>/dev/null | jq -r --arg label "$TARGET_LABEL" '
    (.result.workspaces // []) | .[] | select(.label == $label) | .workspace_id
  ' 2>/dev/null | head -n1
}

# Builds --token/--clear-token args for one metric's four bucket variants,
# setting only the active bucket and clearing the other three so exactly
# one renders (rows drop a token with no value).
bucket_token_args() {
  local prefix="$1" value="$2" bucket="$3" label="$4"
  local b
  for b in unknown ok warn hot; do
    if [[ "$b" == "$bucket" ]]; then
      printf '%s\0%s\0' "--token" "${prefix}_${b}=${label} ${value}"
    else
      printf '%s\0%s\0' "--clear-token" "${prefix}_${b}"
    fi
  done
}

push_once() {
  local wid cpu mem cpu_bucket mem_bucket
  wid=$(target_workspace_id)
  if [[ -z "$wid" ]]; then
    log "no workspace labeled '$TARGET_LABEL' found; skipping cycle"
    return
  fi

  cpu=$(sys_cpu)
  mem=$(sys_mem)
  [[ -z "$cpu" ]] && cpu="--"
  [[ -z "$mem" ]] && mem="--"

  # cpu: ok <50, warn 50-79, hot >=80. mem: ok <60, warn 60-79, hot >=80.
  # "--" (no reading yet) maps to "unknown" via sys_bucket.
  cpu_bucket=$(sys_bucket "$cpu" 50 80)
  mem_bucket=$(sys_bucket "$mem" 60 80)

  local args=()
  while IFS= read -r -d '' arg; do
    args+=("$arg")
  done < <(bucket_token_args "sys_cpu" "$cpu" "$cpu_bucket" "CPU"
    bucket_token_args "sys_mem" "$mem" "$mem_bucket" "MEM")

  "$HERDR" workspace report-metadata "$wid" --source "$SOURCE_ID" \
    --clear-token "sys_cpu" --clear-token "sys_mem" \
    --ttl-ms "$TTL_MS" \
    "${args[@]}" \
    >/dev/null 2>&1 || log "report-metadata failed for $wid"
}

main_loop() {
  command -v jq >/dev/null 2>&1 || {
    log "jq not found; exiting"
    exit 1
  }
  log "sysmon poller started (cadence ${CADENCE_SEC}s, herdr=${HERDR}, os=$(sys_os))"
  push_once
  while true; do
    sleep "$CADENCE_SEC"
    push_once
  done
}

spawn() {
  local pid
  if [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null) && kill -0 "$pid" 2>/dev/null; then
    log "poller already running (pid $pid); not respawning"
    exit 0
  fi
  nohup bash "$SCRIPT_DIR/poll.sh" --run </dev/null >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  disown 2>/dev/null || true
  log "spawned poller pid $(cat "$PIDFILE")"
}

stop() {
  local pid
  if [[ -f "$PIDFILE" ]] && pid=$(cat "$PIDFILE" 2>/dev/null) && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null && log "stopped poller pid $pid"
  else
    log "no running poller to stop"
  fi
  rm -f "$PIDFILE"
}

case "${1:-}" in
--spawn) spawn ;;
--stop) stop ;;
--run | "") main_loop ;;
*)
  echo "usage: poll.sh [--spawn|--run|--stop]" >&2
  exit 2
  ;;
esac
