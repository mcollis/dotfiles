"""Shared helpers: config/state locations, time, opaque identifiers.

Nothing here is user- or organization-specific. Locations follow XDG defaults and
can be overridden with environment variables.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_CONFIG = {
    "sources": {
        "opencode": {"enabled": "auto", "command": "opencode"},
        "claude": {"enabled": "auto", "root": "~/.claude/projects"},
        "codex": {"enabled": "auto", "root": "~/.codex/sessions"},
    },
    "default_window_days": 30,
    "limits": {
        "max_sessions_per_batch": 25,
        "max_chars_per_turn": 1200,
        "max_chars_per_session": 24000,
        "warn_record_bytes": 1048576,
        "max_record_bytes": 26214400,
    },
    "privacy": {"deny_terms": [], "deny_patterns": []},
    "persistence": {"backend": "none"},
}


def _dir_from(env_name: str, xdg_name: str, fallback: str) -> Path:
    explicit = os.environ.get(env_name)
    if explicit:
        return Path(explicit).expanduser()
    base = os.environ.get(xdg_name) or str(Path.home() / fallback)
    return Path(base) / "workflow-retrospective"


def config_dir() -> Path:
    return _dir_from("WORKFLOW_RETROSPECTIVE_CONFIG_DIR", "XDG_CONFIG_HOME", ".config")


def state_dir() -> Path:
    return _dir_from("WORKFLOW_RETROSPECTIVE_STATE_DIR", "XDG_STATE_HOME", ".local/state")


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    path = config_dir() / "config.json"
    if not path.exists():
        return copy.deepcopy(DEFAULT_CONFIG)
    try:
        data = json.loads(path.read_text())
    except ValueError as exc:
        raise SystemExit("ERROR: %s is not valid JSON: %s" % (path, exc))
    if not isinstance(data, dict):
        raise SystemExit("ERROR: %s must contain a JSON object" % path)
    return _merge(DEFAULT_CONFIG, data)


def machine_id() -> str:
    """Opaque, random, machine-local identifier; never derived from hostnames."""
    path = state_dir() / "machine.json"
    if path.exists():
        try:
            return json.loads(path.read_text())["machine"]
        except (ValueError, KeyError):
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    value = "m-" + uuid.uuid4().hex[:12]
    path.write_text(json.dumps({"machine": value}) + "\n")
    return value


def sid(source: str, native_id: str, machine: str = "") -> str:
    """Stable opaque session identifier used in persisted records."""
    machine = machine or machine_id()
    return hashlib.sha256(("%s:%s:%s" % (machine, source, native_id)).encode()).hexdigest()[:16]


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_ms(value) -> int:
    """Accepts epoch ms/s numbers or ISO-8601 strings."""
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    text = str(value).strip()
    if text.isdigit():
        return to_ms(int(text))
    text = text.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def truncate(text, limit: int) -> str:
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    if len(text) <= limit:
        return text
    return text[:limit] + "…[+%d chars]" % (len(text) - limit)


def emit(obj) -> None:
    json.dump(obj, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def die(message: str, code: int = 1):
    sys.stderr.write("ERROR: %s\n" % message)
    raise SystemExit(code)
