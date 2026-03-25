#!/bin/bash
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name')
# Shorten long model IDs like "global.anthropic.claude-opus-4-6-v1"
case "$MODEL" in
  *opus*)   MODEL="Opus" ;;
  *sonnet*) MODEL="Sonnet" ;;
  *haiku*)  MODEL="Haiku" ;;
esac
DIR=$(echo "$input" | jq -r '.workspace.current_dir')
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
DURATION_MS=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')

# Terminal ANSI colors
BLUE='\033[34m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

# Pick bar color based on context usage
if [ "$PCT" -ge 90 ]; then BAR_COLOR="$RED"
elif [ "$PCT" -ge 70 ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$GREEN"; fi

FILLED=$((PCT / 10)); EMPTY=$((10 - FILLED))
BAR=""
DIM='\033[2m'
for ((i=0; i<FILLED; i++)); do BAR+="▪"; done
for ((i=0; i<EMPTY; i++)); do BAR+="${DIM}▪${RESET}${BAR_COLOR}"; done

TOTAL_SECS=$((DURATION_MS / 1000))
HOURS=$((TOTAL_SECS / 3600))
MINS=$(((TOTAL_SECS % 3600) / 60))
SECS=$((TOTAL_SECS % 60))

BRANCH=""
git rev-parse --git-dir > /dev/null 2>&1 && BRANCH=" | 🌿 $(git branch --show-current 2>/dev/null)"

echo -e "${BLUE}[$MODEL]${RESET} 📁 ${DIR##*/}$BRANCH"
COST_FMT=$(printf '$%.2f' "$COST")
echo -e "${BAR_COLOR}${BAR}${RESET} ${PCT}% | ${YELLOW}${COST_FMT}${RESET} | ⏱️ $([ "$HOURS" -gt 0 ] && echo "${HOURS}h ")${MINS}m ${SECS}s"
