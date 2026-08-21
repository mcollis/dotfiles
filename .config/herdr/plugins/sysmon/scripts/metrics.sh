#!/usr/bin/env bash
# metrics.sh — CPU and memory collectors for Linux and macOS. Sourced by poll.sh.
# Each function returns a non-empty string, or "--" on failure.

sys_os() {
  uname -s 2>/dev/null
}

# --- Linux -------------------------------------------------------------

# CPU usage % since the previous cycle, computed from /proc/stat deltas.
# On the first call (no prior sample) returns "--"; the next cycle has data.
sys_cpu_linux() {
  local state_file line user nice system idle iowait irq softirq steal
  local cur_total cur_idle prev_total prev_idle diff_total diff_idle pct

  state_file="${HERDR_PLUGIN_STATE_DIR:-.}/proc_stat.prev"

  line=$(awk '/^cpu /{print; exit}' /proc/stat 2>/dev/null)
  if [[ -z "$line" ]]; then
    echo "--"
    return
  fi
  read -r _ user nice system idle iowait irq softirq steal _ <<<"$line"
  cur_total=$((user + nice + system + idle + iowait + irq + softirq + steal))
  cur_idle=$((idle + iowait))

  local prev=""
  [[ -f "$state_file" ]] && prev=$(cat "$state_file" 2>/dev/null)
  printf '%s %s\n' "$cur_total" "$cur_idle" >"$state_file" 2>/dev/null

  read -r prev_total prev_idle <<<"$prev"
  if [[ -z "$prev_total" || -z "$prev_idle" ]]; then
    echo "--"
    return
  fi

  diff_total=$((cur_total - prev_total))
  diff_idle=$((cur_idle - prev_idle))
  if ((diff_total <= 0)); then
    echo "--"
    return
  fi

  pct=$(((100 * (diff_total - diff_idle)) / diff_total))
  printf '%d%%' "$pct"
}

# Memory used %, from /proc/meminfo (MemTotal vs MemAvailable).
sys_mem_linux() {
  awk '
    /^MemTotal:/     { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END {
      if (total > 0) {
        printf "%.0f%%", 100 * (total - avail) / total
      } else {
        print "--"
      }
    }
  ' /proc/meminfo 2>/dev/null
}

# --- macOS ---------------------------------------------------------------

# CPU usage % from a single `top` sample. -n0 suppresses the process list
# for speed; -l1 is one sample (a since-launch average is fine for a
# glance metric and avoids the latency of a delta-mode two-sample read).
sys_cpu_macos() {
  top -l1 -n0 2>/dev/null | awk '
    /CPU usage/ {
      gsub(/%/, "", $7)          # "81.99%" -> "81.99"  (idle is field 7)
      printf "%.0f%%", (100 - ($7 + 0))
    }'
}

# Memory used %, from vm_stat (active + wired pages) vs hw.memsize.
# vm_stat prints its own page size in the header, so we read it from
# there instead of assuming 4096 (Intel) or 16384 (Apple Silicon).
sys_mem_macos() {
  local total_bytes
  total_bytes=$(sysctl -n hw.memsize 2>/dev/null)
  [[ -z "$total_bytes" ]] && {
    echo "--"
    return
  }

  vm_stat 2>/dev/null | awk -v total="$total_bytes" '
    /page size of/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) page_size = $i }
    /Pages active/     { gsub(/\./, "", $3); active = $3 }
    /Pages wired down/ { gsub(/\./, "", $4); wired  = $4 }
    END {
      if (page_size > 0 && total > 0) {
        printf "%.0f%%", (active + wired) * page_size * 100 / total
      } else {
        print "--"
      }
    }
  '
}

# --- Dispatch --------------------------------------------------------------

sys_cpu() {
  local value
  case "$(sys_os)" in
  Darwin) value=$(sys_cpu_macos) ;;
  *) value=$(sys_cpu_linux) ;;
  esac
  [[ -z "$value" ]] && value="--"
  printf '%s' "$value"
}

sys_mem() {
  local value
  case "$(sys_os)" in
  Darwin) value=$(sys_mem_macos) ;;
  *) value=$(sys_mem_linux) ;;
  esac
  [[ -z "$value" ]] && value="--"
  printf '%s' "$value"
}

# Maps a "NN%" or "--" value to a threshold bucket: ok, warn, hot, or
# unknown (first cycle / failed reading). warn_at/hot_at are inclusive
# lower bounds.
sys_bucket() {
  local value="$1" warn_at="$2" hot_at="$3" numeric
  [[ "$value" == "--" ]] && {
    echo "unknown"
    return
  }
  numeric="${value%\%}"
  [[ "$numeric" =~ ^[0-9]+$ ]] || {
    echo "unknown"
    return
  }
  if ((numeric >= hot_at)); then
    echo "hot"
  elif ((numeric >= warn_at)); then
    echo "warn"
  else
    echo "ok"
  fi
}
