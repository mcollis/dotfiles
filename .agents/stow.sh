#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
HOME_ROOT="${HOME:?HOME is required}"
BACKUP_ROOT="$HOME_ROOT/.local/state/agents-stow/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP_DIR="$BACKUP_ROOT/$STAMP"
BACKUP_MANIFEST="$BACKUP_DIR/manifest.tsv"
BACKUP_CREATED=0
CHECK_STATUS=0
CREATED_PATHS=()

die() {
    printf 'agents-stow: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

for command_name in cmp cp date dirname find ln mkdir mktemp mv readlink rm sort stow tail; do
    require_command "$command_name"
done

backup_path() {
    local path="$1"
    local relative="${path#"$HOME_ROOT"/}"
    local destination="$BACKUP_DIR/$relative"

    [ -e "$path" ] || [ -L "$path" ] || return 0
    [ -e "$destination" ] || [ -L "$destination" ] || {
        mkdir -p "$(dirname "$destination")"
        cp -a "$path" "$destination"
        mkdir -p "$BACKUP_DIR"
        printf '%s\t%s\n' "$path" "$destination" >> "$BACKUP_MANIFEST"
        BACKUP_CREATED=1
    }
}

record_created() {
    local path="$1"

    CREATED_PATHS+=("$path")
}

write_created_manifest() {
    local path

    [ "${#CREATED_PATHS[@]}" -gt 0 ] || return 0
    mkdir -p "$BACKUP_DIR"
    for path in "${CREATED_PATHS[@]}"; do
        printf '%s\t\n' "$path" >> "$BACKUP_MANIFEST"
    done
    BACKUP_CREATED=1
}

remove_path() {
    local path="$1"

    if [ -e "$path" ] || [ -L "$path" ]; then
        rm -rf -- "$path"
    fi
}

matches_source() {
    local destination="$1"
    local source="$2"

    [ -L "$destination" ] &&
        [ "$(readlink -f "$destination")" = "$(readlink -f "$source")" ]
}

prepare_package() {
    local package_root="$1"
    local target="$2"
    local ignore_name="${3:-}"
    local source_entry name destination

    mkdir -p "$target"
    while IFS= read -r -d '' source_entry; do
        name="${source_entry##*/}"
        [ "$name" = "$ignore_name" ] && continue
        destination="$target/$name"
        matches_source "$destination" "$source_entry" && continue
        if [ -e "$destination" ] || [ -L "$destination" ]; then
            backup_path "$destination"
            remove_path "$destination"
        else
            record_created "$destination"
        fi
    done < <(find "$package_root" -mindepth 1 -maxdepth 1 -print0)
}

stow_package() {
    local package_parent="$1"
    local target="$2"
    local package="$3"
    local ignore_name="${4:-}"
    local -a options=(--dir="$package_parent" --target="$target")

    [ -n "$ignore_name" ] && options+=(--ignore="^${ignore_name//./\\.}$")
    stow "${options[@]}" "$package"
}

unstow_package() {
    local package_parent="$1"
    local target="$2"
    local package="$3"
    local ignore_name="${4:-}"
    local -a options=(--dir="$package_parent" --target="$target" --delete)

    [ -d "$target" ] || return 0
    [ -n "$ignore_name" ] && options+=(--ignore="^${ignore_name//./\\.}$")
    stow "${options[@]}" "$package"
}

link_directory() {
    local source="$1"
    local destination="$2"

    mkdir -p "$(dirname "$destination")"
    if matches_source "$destination" "$source"; then
        return 0
    fi
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        backup_path "$destination"
        remove_path "$destination"
    else
        record_created "$destination"
    fi
    ln -s "$source" "$destination"
}

check_package() {
    local package_parent="$1"
    local target="$2"
    local package="$3"
    local ignore_name="${4:-}"
    local -a options=(--dir="$package_parent" --target="$target" --no --verbose)

    if [ ! -d "$target" ]; then
        printf 'MISSING %s\n' "$target"
        CHECK_STATUS=1
        return 0
    fi
    [ -n "$ignore_name" ] && options+=(--ignore="^${ignore_name//./\\.}")
    if ! stow "${options[@]}" "$package"; then
        CHECK_STATUS=1
    fi
}

check_link() {
    local source="$1"
    local destination="$2"

    if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
        printf 'MISSING %s\n' "$destination"
        CHECK_STATUS=1
    elif ! matches_source "$destination" "$source"; then
        printf 'DRIFT   %s\n' "$destination"
        CHECK_STATUS=1
    fi
}

remove_legacy_plugin_link() {
    if matches_source "$HOME_ROOT/plugins/ex" "$SOURCE_ROOT/plugins/ex"; then
        backup_path "$HOME_ROOT/plugins/ex"
        remove_path "$HOME_ROOT/plugins/ex"
        rmdir "$HOME_ROOT/plugins" 2>/dev/null || true
    fi
}

check() {
    check_package "$SOURCE_ROOT" "$HOME_ROOT/.agents/skills" skills
    check_package "$SOURCE_ROOT" "$HOME_ROOT/.claude/skills" skills
    check_package "$SOURCE_ROOT" "$HOME_ROOT/.codex/skills" skills
    check_package "$SOURCE_ROOT" "$HOME_ROOT/.agents/hooks" hooks
    check_package "$SOURCE_ROOT" "$HOME_ROOT/.claude" claude
    check_package "$SOURCE_ROOT" "$HOME_ROOT/.codex" codex marketplace.json
    check_link "$SOURCE_ROOT/plugins/ex" "$HOME_ROOT/.agents/plugins/ex"
    check_link "$HOME_ROOT/.agents/plugins/ex" "$HOME_ROOT/.claude/plugins/ex"
    if matches_source "$HOME_ROOT/plugins/ex" "$SOURCE_ROOT/plugins/ex"; then
        printf 'STALE   %s\n' "$HOME_ROOT/plugins/ex"
        CHECK_STATUS=1
    fi
    check_link "$SOURCE_ROOT/codex/marketplace.json" \
        "$HOME_ROOT/.agents/plugins/marketplace.json"
    return "$CHECK_STATUS"
}

install_projections() {
    remove_legacy_plugin_link
    prepare_package "$SOURCE_ROOT/skills" "$HOME_ROOT/.agents/skills"
    prepare_package "$SOURCE_ROOT/skills" "$HOME_ROOT/.claude/skills"
    prepare_package "$SOURCE_ROOT/skills" "$HOME_ROOT/.codex/skills"
    prepare_package "$SOURCE_ROOT/hooks" "$HOME_ROOT/.agents/hooks"
    prepare_package "$SOURCE_ROOT/claude" "$HOME_ROOT/.claude"
    prepare_package "$SOURCE_ROOT/codex" "$HOME_ROOT/.codex" marketplace.json
    stow_package "$SOURCE_ROOT" "$HOME_ROOT/.agents/skills" skills
    stow_package "$SOURCE_ROOT" "$HOME_ROOT/.claude/skills" skills
    stow_package "$SOURCE_ROOT" "$HOME_ROOT/.codex/skills" skills
    stow_package "$SOURCE_ROOT" "$HOME_ROOT/.agents/hooks" hooks
    stow_package "$SOURCE_ROOT" "$HOME_ROOT/.claude" claude
    stow_package "$SOURCE_ROOT" "$HOME_ROOT/.codex" codex marketplace.json
    link_directory "$SOURCE_ROOT/plugins/ex" "$HOME_ROOT/.agents/plugins/ex"
    link_directory "$HOME_ROOT/.agents/plugins/ex" "$HOME_ROOT/.claude/plugins/ex"
    link_directory "$SOURCE_ROOT/codex/marketplace.json" \
        "$HOME_ROOT/.agents/plugins/marketplace.json"
    write_created_manifest
    if [ "$BACKUP_CREATED" -eq 1 ]; then
        printf 'Installed projections; backups are in %s\n' "$BACKUP_DIR"
    else
        printf 'Installed projections; no backup was needed.\n'
    fi
}

remove_projections() {
    unstow_package "$SOURCE_ROOT" "$HOME_ROOT/.agents/skills" skills
    unstow_package "$SOURCE_ROOT" "$HOME_ROOT/.claude/skills" skills
    unstow_package "$SOURCE_ROOT" "$HOME_ROOT/.codex/skills" skills
    unstow_package "$SOURCE_ROOT" "$HOME_ROOT/.agents/hooks" hooks
    unstow_package "$SOURCE_ROOT" "$HOME_ROOT/.claude" claude
    unstow_package "$SOURCE_ROOT" "$HOME_ROOT/.codex" codex marketplace.json
    matches_source "$HOME_ROOT/.claude/plugins/ex" "$HOME_ROOT/.agents/plugins/ex" &&
        remove_path "$HOME_ROOT/.claude/plugins/ex"
    matches_source "$HOME_ROOT/.agents/plugins/ex" "$SOURCE_ROOT/plugins/ex" &&
        remove_path "$HOME_ROOT/.agents/plugins/ex"
    matches_source "$HOME_ROOT/plugins/ex" "$SOURCE_ROOT/plugins/ex" &&
        remove_legacy_plugin_link
    matches_source "$HOME_ROOT/.agents/plugins/marketplace.json" \
        "$SOURCE_ROOT/codex/marketplace.json" &&
        remove_path "$HOME_ROOT/.agents/plugins/marketplace.json"
}

remove_skill() {
    local name="${1:-}"
    local source="$SOURCE_ROOT/skills/$name"
    local target

    [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] ||
        die "skill name must contain only lowercase letters, numbers, and hyphens"
    [ -d "$source" ] || die "skill not found: $name"
    for target in "$HOME_ROOT/.agents/skills/$name" \
        "$HOME_ROOT/.claude/skills/$name" "$HOME_ROOT/.codex/skills/$name"; do
        if matches_source "$target" "$source"; then
            backup_path "$target"
            remove_path "$target"
        fi
    done
    backup_path "$source"
    remove_path "$source"
    printf 'Removed skill %s; backup is in %s\n' "$name" "$BACKUP_DIR"
}

rollback() {
    local latest target backup

    latest="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print |
        sort | tail -1)"
    [ -n "$latest" ] || die "no backup sets found"
    [ -f "$latest/manifest.tsv" ] ||
        die "backup set has no manifest: $latest"
    while IFS=$'\t' read -r target backup; do
        [ -n "$target" ] || continue
        remove_path "$target"
        [ -n "$backup" ] || continue
        mkdir -p "$(dirname "$target")"
        cp -a "$backup" "$target"
        printf 'Restored %s\n' "$target"
    done < "$latest/manifest.tsv"
    printf 'Rollback complete from %s\n' "$latest"
}

case "${1:-check}" in
    check)
        check
        ;;
    install)
        install_projections
        ;;
    restow)
        remove_projections
        install_projections
        ;;
    remove-skill)
        remove_skill "${2:-}"
        ;;
    remove)
        remove_projections
        ;;
    rollback)
        rollback
        ;;
    *)
        die "usage: $0 {check|install|restow|remove|rollback}"
        ;;
esac
