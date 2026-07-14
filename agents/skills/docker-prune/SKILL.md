---
name: docker-prune
description: Reclaim disk space from untagged Docker images, build cache, dangling networks and volumes. Generic — works against any Docker host. Scans first, asks for confirmation per category, then prunes. Use when user asks to clean up Docker, reclaim space, or prune images.
---

# Docker Prune

Reports reclaimable Docker disk usage and prunes (with per-category confirmation) untagged images older than a configurable window, build cache, dangling networks, and dangling volumes.

Does NOT touch:

- Images currently referenced by a running or stopped container (Docker refuses)
- `vsc-user-*` devcontainer images tied to worktrees — see `/ex:worktree-prune` for that

## Instructions

### 1. Scan

Run the scan script and display its output:

```bash
${CLAUDE_SKILL_DIR}/scan.sh
```

It prints four sections:

- **UNTAGGED IMAGES** — count and total size, with an age filter
- **BUILD CACHE** — total size
- **DANGLING NETWORKS** — count
- **DANGLING VOLUMES** — count

The age filter defaults to 720 hours (30 days). Override with `DOCKER_PRUNE_UNTIL=72h` etc. Note this is build/created age, not last-used — the digest-pin protection (not age) is what keeps the live stage base image safe, so a long-lived base image is never at risk regardless of this window.

### 2. Confirm and prune

For each non-empty category, ask the user whether to prune. Only run the corresponding command on confirmation:

| Category | Command |
|---|---|
| Untagged images | `source ~/.claude/lib/docker.sh && ids=$(prunable_untagged_image_ids "${DOCKER_PRUNE_UNTIL:-720h}") && [ -n "$ids" ] && docker rmi $ids` |
| Build cache | `docker builder prune -a --filter "until=${DOCKER_PRUNE_UNTIL:-720h}"` |
| Dangling networks | `docker network prune -f` |
| Dangling volumes | `docker volume prune -f` |

> **Do NOT use `docker image prune -a`** for untagged images. The depot stage
> base image (`depot-stage/combined`, ~25GB) is pinned **by digest** in
> `docker-compose.yml`, so it is untagged and `prune -a` would delete it —
> forcing `make start-ui-dev` to re-download 25GB. `prunable_untagged_image_ids`
> excludes any image pinned by a worktree's `.env` `DEPOT_STAGE_DIGEST`, so the
> live base image is protected while genuinely stale untagged images (including
> the *old* stage image after a digest bump) are still reclaimed.

### 3. Summary

After each prune, report what was removed and how much was reclaimed. Show the user `docker system df` after all confirmed categories are done so they can see the post-prune state.

## Safety

- Does not use `docker system prune -a` (too broad; removes images that might be intentional)
- Does not use `docker image prune -a` either — it would delete the digest-pinned ~25GB depot stage base image (untagged, so it looks dangling), forcing a 25GB re-download on the next `make start-ui-dev`. Prune an explicit ID list from `prunable_untagged_image_ids` instead, which excludes images pinned by any worktree `.env`.
- Never runs without per-category confirmation
- `until=720h` default keeps any untagged image created in the last 30 days. This is created-time, NOT last-used — Docker doesn't track image last-use. Age is therefore a weak signal for the base stage image (it's long-lived and rarely rebuilt, so it's *always* "old"); the digest-pin from a current worktree `.env` is what actually protects it, independent of age.
