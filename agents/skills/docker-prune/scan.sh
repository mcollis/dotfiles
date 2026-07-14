#!/usr/bin/env bash
set -euo pipefail

source ~/.claude/lib/docker.sh

UNTIL="${DOCKER_PRUNE_UNTIL:-720h}"

if ! command -v docker >/dev/null; then
    echo "ERROR: docker not available"
    exit 1
fi

echo "=== DOCKER SYSTEM DF ==="
docker system df 2>/dev/null || echo "(failed)"
echo

echo "=== UNTAGGED IMAGES (older than $UNTIL) ==="
# Safe candidate set excludes worktree-pinned stage images (see docker.sh).
prunable_ids=$(prunable_untagged_image_ids "$UNTIL")
count=$(grep -c . <<<"$prunable_ids" 2>/dev/null || echo 0)
[ -z "$prunable_ids" ] && count=0
if [ "$count" -gt 0 ]; then
    echo "Count: $count"
    # Dry-run by showing what would be removed (only the safe candidates).
    docker image inspect $(echo "$prunable_ids" | head -20) \
        --format 'table {{.Id}}\t{{index .RepoTags 0}}' 2>/dev/null \
        | sed 's|sha256:||' | head -20 || echo "$prunable_ids" | head -20
    [ "$count" -gt 20 ] && echo "  …and $((count - 20)) more"
else
    echo "(none)"
fi
# Surface any protected (pinned) stage image so the user knows why it's kept.
protected_ids=$(pinned_stage_image_ids)
if [ -n "$protected_ids" ]; then
    echo
    echo "  PROTECTED (digest-pinned by a worktree .env — would re-download if pruned):"
    docker image inspect $protected_ids \
        --format '    {{slice .Id 7 19}}  {{index .RepoDigests 0}}  {{.Size}}' 2>/dev/null || true
fi
echo

echo "=== BUILD CACHE ==="
docker system df -v 2>/dev/null | awk '
    /^Build cache usage:/ { print; getline; print }
' | head -10 || echo "(none visible)"
echo

echo "=== DANGLING NETWORKS ==="
count=$(dangling_network_count)
if [ "$count" -gt 0 ]; then
    docker network ls --filter dangling=true --format 'table {{.ID}}\t{{.Name}}' 2>/dev/null | head -15
    [ "$count" -gt 14 ] && echo "  …and more"
else
    echo "(none)"
fi
echo

echo "=== DANGLING VOLUMES ==="
count=$(dangling_volume_count)
if [ "$count" -gt 0 ]; then
    docker volume ls --filter dangling=true --format 'table {{.Name}}\t{{.Driver}}' 2>/dev/null | head -15
    [ "$count" -gt 14 ] && echo "  …and more"
else
    echo "(none)"
fi
