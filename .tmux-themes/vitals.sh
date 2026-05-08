#!/usr/bin/env bash
# Emits tmux status-right segments: [MEM xx%] [CPU xx%] [host]
# Segment backgrounds shift green/yellow/red by threshold.

SEP=$''   # powerline right-pointing triangle (U+E0B2)
CACHE=/tmp/tmux-vitals-cpu.$UID

# Memory % used
read -r _ total _ <<<"$(awk '/^MemTotal:/{print $0}' /proc/meminfo)"
read -r _ avail _ <<<"$(awk '/^MemAvailable:/{print $0}' /proc/meminfo)"
mem_pct=$(( (total - avail) * 100 / total ))

# CPU % used: diff /proc/stat against cached prior snapshot
read -r _ u n s i io irq sirq st _ < /proc/stat
total_now=$((u + n + s + i + io + irq + sirq + st))
idle_now=$((i + io))

if [[ -r $CACHE ]]; then
  read -r total_prev idle_prev < "$CACHE"
  dt=$((total_now - total_prev))
  di=$((idle_now - idle_prev))
  if (( dt > 0 )); then
    cpu_pct=$(( (dt - di) * 100 / dt ))
  else
    cpu_pct=0
  fi
else
  cpu_pct=0
fi
echo "$total_now $idle_now" > "$CACHE"

color_for() {
  local pct=$1 hi=$2 med=$3
  if   (( pct >= hi  )); then echo colour1   # red
  elif (( pct >= med )); then echo colour3   # yellow
  else                        echo colour2   # green
  fi
}

MEM_BG=$(color_for "$mem_pct" 90 70)
CPU_BG=$(color_for "$cpu_pct" 95 80)
HOST_BG=colour4

printf '#[fg=%s,bg=default]%s#[fg=colour0,bg=%s,bold] MEM %d%% ' \
  "$MEM_BG" "$SEP" "$MEM_BG" "$mem_pct"
printf '#[fg=colour0,bg=%s,nobold]%s#[fg=%s,bg=colour0]%s#[fg=colour0,bg=%s,bold] CPU %d%% ' \
  "$MEM_BG" "$SEP" "$CPU_BG" "$SEP" "$CPU_BG" "$cpu_pct"
printf '#[fg=colour0,bg=%s,nobold]%s#[fg=%s,bg=colour0]%s#[fg=colour0,bg=%s,bold] #H ' \
  "$CPU_BG" "$SEP" "$HOST_BG" "$SEP" "$HOST_BG"
