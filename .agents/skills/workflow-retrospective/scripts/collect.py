#!/usr/bin/env python3
"""Read-only transcript inventory and retrieval for OpenCode, Claude and Codex.

  collect.py sources
  collect.py inventory [--source S]... [--since T] [--until T]
  collect.py read --source S --ref REF [--after T] [--context-turns N]
                  [--include-sidechains]

Nothing is written. Output is local analysis input and must not be persisted:
only sanitized findings (see record.py) may leave the machine.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wr_common import (  # noqa: E402
    die, emit, iso, load_config, machine_id, now_ms, sid, to_ms, truncate,
)

PAGE = 50
MAX_PAGES = 400


# --------------------------------------------------------------------------
# OpenCode (via the local HTTP API)
# --------------------------------------------------------------------------

def _oc(cfg: dict, path: str) -> dict:
    # stdout goes to a file, not a pipe: the CLI can lose output beyond the pipe
    # buffer (~64 KB) when the reader is slower than its exit.
    cmd = shlex.split(cfg["command"]) + ["api", "get", path]
    last = "opencode api returned non-JSON output"
    for _ in range(2):
        with tempfile.TemporaryFile() as out:
            try:
                proc = subprocess.run(cmd, stdout=out, stderr=subprocess.PIPE, text=True, timeout=120)
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise RuntimeError("opencode api unavailable: %s" % exc)
            if proc.returncode != 0:
                raise RuntimeError("opencode api failed: %s" % truncate(proc.stderr.strip(), 200))
            out.seek(0)
            try:
                return json.loads(out.read().decode("utf-8", "replace"))
            except ValueError:
                continue
    raise RuntimeError(last)


def oc_available(cfg: dict):
    try:
        _oc(cfg, "/api/info")
        return True, ""
    except RuntimeError as exc:
        return False, str(exc)


def oc_inventory(cfg: dict, since: int, until: int, machine: str):
    sessions, children = [], []
    cursor, first = None, True
    for _ in range(MAX_PAGES):
        query = "limit=%d" % PAGE
        query += "&order=desc" if first else "&cursor=%s" % quote(cursor, safe="")
        page = _oc(cfg, "/api/session?" + query)
        rows = page.get("data") or []
        if not rows:
            break
        for row in rows:
            t = row.get("time") or {}
            updated = int(t.get("updated") or t.get("created") or 0)
            if updated < since or updated > until:
                continue
            item = {
                "source": "opencode",
                "ref": row["id"],
                "sid": sid("opencode", row["id"], machine),
                "title": row.get("title") or "",
                "cwd": (row.get("location") or {}).get("directory"),
                "agent": row.get("agent"),
                "model": "/".join(
                    x for x in ((row.get("model") or {}).get("providerID"), (row.get("model") or {}).get("id")) if x
                ),
                "created_ms": int(t.get("created") or updated),
                "updated_ms": updated,
            }
            if row.get("parentID"):
                item["parent_sid"] = sid("opencode", row["parentID"], machine)
                children.append(item)
            else:
                sessions.append(item)
        oldest = min(int((r.get("time") or {}).get("updated") or 0) for r in rows)
        cursor = ((page.get("cursor") or {}).get("next"))
        first = False
        if not cursor or oldest < since:
            break
    return sessions, children


def _oc_tool_turn(block: dict, limit: int) -> dict:
    state = block.get("state") or {}
    turn = {"role": "tool", "tool": block.get("name"), "status": state.get("status")}
    args = state.get("input")
    if args:
        turn["input"] = truncate(args, min(limit, 300))
    err = state.get("error")
    if err:
        turn["error"] = truncate(err, 200)
    return turn


def oc_read(cfg: dict, ref: str, limit: int):
    turns, cursor, first = [], None, True
    for _ in range(MAX_PAGES):
        query = "limit=%d" % PAGE
        query += "&order=asc" if first else "&cursor=%s" % quote(cursor, safe="")
        page = _oc(cfg, "/api/session/%s/message?%s" % (quote(ref, safe=""), query))
        rows = page.get("data") or []
        if not rows:
            break
        for msg in rows:
            kind = msg.get("type")
            t = (msg.get("time") or {}).get("created")
            base = {"t": iso(int(t)) if t else None, "_ms": int(t) if t else 0}
            if kind == "user":
                turn = dict(base, role="user", text=truncate(msg.get("text") or "", limit))
                skills = [s.get("name") or s.get("id") for s in msg.get("skills") or []]
                if skills:
                    turn["skills"] = skills
                turns.append(turn)
            elif kind == "assistant":
                for block in msg.get("content") or []:
                    if block.get("type") == "text" and block.get("text"):
                        turns.append(dict(base, role="assistant", text=truncate(block["text"], limit)))
                    elif block.get("type") == "tool":
                        turns.append(dict(base, **_oc_tool_turn(block, limit)))
            elif kind == "shell":
                turns.append(dict(base, role="tool", tool="shell", input=truncate(msg.get("command") or "", 300)))
            elif kind in ("agent-switched", "model-switched"):
                detail = msg.get("agent") or msg.get("model") or ""
                turns.append(dict(base, role="event", kind=kind, detail=truncate(detail, 80)))
        cursor = ((page.get("cursor") or {}).get("next"))
        first = False
        if not cursor:
            break
    return turns


# --------------------------------------------------------------------------
# Claude (local JSONL, one file per session)
# --------------------------------------------------------------------------

def _jsonl(path: Path):
    with path.open(errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def _tail_timestamp(path: Path):
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            handle.seek(max(0, size - 65536))
            tail = handle.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in reversed(tail):
        try:
            stamp = json.loads(line).get("timestamp")
        except ValueError:
            continue
        if stamp:
            return to_ms(stamp)
    return None


def _first_meta(path: Path):
    for rec in _jsonl(path):
        if rec.get("timestamp"):
            return to_ms(rec["timestamp"]), rec.get("cwd")
    return None, None


def claude_inventory(cfg: dict, since: int, until: int, machine: str):
    root = Path(cfg["root"]).expanduser()
    sessions = []
    for path in sorted(root.glob("*/*.jsonl")):
        updated = _tail_timestamp(path) or int(path.stat().st_mtime * 1000)
        if updated < since or updated > until:
            continue
        created, cwd = _first_meta(path)
        title = ""
        if path.stat().st_size < 5_000_000:
            for rec in _jsonl(path):
                if rec.get("type") == "ai-title" and rec.get("aiTitle"):
                    title = rec["aiTitle"]
        sessions.append({
            "source": "claude", "ref": str(path), "sid": sid("claude", path.stem, machine),
            "title": title, "cwd": cwd, "created_ms": created or updated, "updated_ms": updated,
        })
    return sessions, []


def _claude_turns(path: Path, limit: int, include_sidechains: bool):
    turns = []
    for rec in _jsonl(path):
        kind = rec.get("type")
        if kind not in ("user", "assistant") or rec.get("isMeta"):
            continue
        if rec.get("isSidechain") and not include_sidechains:
            continue
        stamp = rec.get("timestamp")
        base = {"t": stamp, "_ms": to_ms(stamp) if stamp else 0}
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for block in content or []:
            btype = block.get("type")
            if kind == "user" and btype == "text":
                turns.append(dict(base, role="user", text=truncate(block.get("text", ""), limit)))
            elif kind == "user" and btype == "tool_result":
                body = block.get("content")
                if isinstance(body, list):
                    body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
                turns.append(dict(base, role="tool_result", error=bool(block.get("is_error")),
                                  text=truncate(body or "", 200)))
            elif kind == "assistant" and btype == "text" and block.get("text"):
                turns.append(dict(base, role="assistant", text=truncate(block["text"], limit)))
            elif kind == "assistant" and btype == "tool_use":
                turns.append(dict(base, role="tool", tool=block.get("name"),
                                  input=truncate(block.get("input"), 300)))
    return turns


# --------------------------------------------------------------------------
# Codex (local JSONL rollouts)
# --------------------------------------------------------------------------

def codex_inventory(cfg: dict, since: int, until: int, machine: str):
    root = Path(cfg["root"]).expanduser()
    sessions, children = [], []
    for path in sorted(root.glob("*/*/*/*.jsonl")):
        meta, first_ts = None, None
        for rec in _jsonl(path):
            if rec.get("type") == "session_meta":
                meta = rec.get("payload") or {}
                first_ts = rec.get("timestamp")
            break
        if meta is None:
            continue
        updated = _tail_timestamp(path) or int(path.stat().st_mtime * 1000)
        if updated < since or updated > until:
            continue
        native = meta.get("id") or path.stem
        item = {
            "source": "codex", "ref": str(path), "sid": sid("codex", native, machine),
            "title": "", "cwd": meta.get("cwd"),
            "created_ms": to_ms(first_ts) if first_ts else updated, "updated_ms": updated,
        }
        origin = meta.get("source")
        if isinstance(origin, dict) and any("subagent" in str(k).lower() for k in origin):
            parent = next((v for k, v in origin.items() if "parent" in str(k).lower()), None)
            if parent:
                item["parent_sid"] = sid("codex", str(parent), machine)
            children.append(item)
        else:
            sessions.append(item)
    return sessions, children


def _codex_turns(path: Path, limit: int):
    turns, calls = [], {}
    for rec in _jsonl(path):
        stamp = rec.get("timestamp")
        base = {"t": stamp, "_ms": to_ms(stamp) if stamp else 0}
        kind, payload = rec.get("type"), rec.get("payload") or {}
        ptype = payload.get("type")
        if kind == "event_msg" and ptype == "user_message":
            turns.append(dict(base, role="user", text=truncate(payload.get("message", ""), limit)))
        elif kind == "event_msg" and ptype == "agent_message":
            turns.append(dict(base, role="assistant", text=truncate(payload.get("message", ""), limit)))
        elif kind == "event_msg" and ptype == "turn_aborted":
            turns.append(dict(base, role="event", kind="interrupted", detail=payload.get("reason", "")))
        elif kind == "response_item" and ptype in ("function_call", "custom_tool_call"):
            turn = dict(base, role="tool", tool=payload.get("name"),
                        input=truncate(payload.get("arguments") or payload.get("input") or "", 300))
            calls[payload.get("call_id")] = turn
            turns.append(turn)
        elif kind == "response_item" and ptype in ("function_call_output", "custom_tool_call_output"):
            turn = calls.get(payload.get("call_id"))
            out = payload.get("output")
            out = out if isinstance(out, str) else json.dumps(out)
            match = re.search(r"exited with code (\d+)", out or "")
            if turn is not None and match:
                turn["exit_code"] = int(match.group(1))
    return turns


# --------------------------------------------------------------------------
# Shared plumbing
# --------------------------------------------------------------------------

def _fit(turns: list, limit_total: int):
    """Shrinks bulky turns first; user turns are never dropped."""
    def size():
        return sum(len(json.dumps(t, ensure_ascii=False)) for t in turns)

    omitted = 0
    if size() > limit_total:
        for t in turns:
            if t["role"] == "assistant":
                t["text"] = truncate(t["text"], 300)
            elif t["role"] == "tool" and t.get("input"):
                t["input"] = truncate(t["input"], 120)
    i = 0
    while size() > limit_total and i < len(turns):
        if turns[i]["role"] in ("assistant", "tool", "tool_result"):
            del turns[i]
            omitted += 1
        else:
            i += 1
    return omitted


def read_session(cfg: dict, source: str, ref: str, after, context_turns: int,
                 include_sidechains: bool, machine: str) -> dict:
    limits = cfg["limits"]
    per_turn = limits["max_chars_per_turn"]
    scfg = cfg["sources"][source]
    if source == "opencode":
        turns = oc_read(scfg, ref, per_turn)
        native = ref
    elif source == "claude":
        path = Path(ref)
        turns = _claude_turns(path, per_turn, include_sidechains)
        native = path.stem
    else:
        path = Path(ref)
        turns = _codex_turns(path, per_turn)
        native = next((r["payload"].get("id") for r in _jsonl(path) if r.get("type") == "session_meta"), path.stem)

    total = len(turns)
    skipped = 0
    if after is not None:
        first = next((i for i, t in enumerate(turns) if t["_ms"] >= after), total)
        keep_from = max(0, first - context_turns)
        for t in turns[keep_from:first]:
            t["context"] = True
        skipped = keep_from
        turns = turns[keep_from:]
    omitted = _fit(turns, limits["max_chars_per_session"])
    for index, t in enumerate(turns):
        t["i"] = index
        t.pop("_ms", None)
    return {
        "source": source, "ref": ref, "sid": sid(source, native, machine),
        "total_turns": total, "turns_before_window": skipped,
        "omitted_turns": omitted, "truncated": bool(omitted),
        "turns": turns,
    }


def sources_status(cfg: dict) -> dict:
    out = {}
    for name, scfg in cfg["sources"].items():
        if scfg.get("enabled") is False:
            out[name] = {"status": "disabled"}
        elif name == "opencode":
            ok, reason = oc_available(scfg)
            out[name] = {"status": "ok" if ok else "unavailable", "reason": reason}
        else:
            root = Path(scfg["root"]).expanduser()
            out[name] = {"status": "ok" if root.is_dir() else "unavailable",
                         "reason": "" if root.is_dir() else "no directory at configured root"}
    return out


INVENTORY = {"opencode": oc_inventory, "claude": claude_inventory, "codex": codex_inventory}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sources")
    inv = sub.add_parser("inventory")
    inv.add_argument("--source", action="append")
    inv.add_argument("--since")
    inv.add_argument("--until")
    rd = sub.add_parser("read")
    rd.add_argument("--source", required=True)
    rd.add_argument("--ref", required=True)
    rd.add_argument("--after")
    rd.add_argument("--context-turns", type=int, default=3)
    rd.add_argument("--include-sidechains", action="store_true")
    args = parser.parse_args(argv)

    cfg = load_config()
    machine = machine_id()

    if args.cmd == "sources":
        emit({"machine": machine, "sources": sources_status(cfg)})
        return 0

    if args.cmd == "inventory":
        until = to_ms(args.until) if args.until else now_ms()
        since = to_ms(args.since) if args.since else until - cfg["default_window_days"] * 86400 * 1000
        wanted = args.source or list(cfg["sources"])
        report, sessions, children = {}, [], []
        for name in wanted:
            scfg = cfg["sources"].get(name)
            if scfg is None or name not in INVENTORY:
                report[name] = {"status": "unknown source"}
                continue
            if scfg.get("enabled") is False:
                report[name] = {"status": "disabled"}
                continue
            try:
                got, kids = INVENTORY[name](scfg, since, until, machine)
            except RuntimeError as exc:
                report[name] = {"status": "error", "reason": str(exc)}
                continue
            except OSError as exc:
                report[name] = {"status": "error", "reason": truncate(str(exc), 200)}
                continue
            report[name] = {"status": "ok", "sessions": len(got), "children": len(kids)}
            sessions += got
            children += kids
        sessions.sort(key=lambda s: s["updated_ms"], reverse=True)
        emit({
            "machine": machine, "window": {"since_ms": since, "until_ms": until,
                                           "since": iso(since), "until": iso(until)},
            "sources": report, "sessions": sessions, "children": children,
        })
        return 0

    if args.source not in INVENTORY:
        die("unknown source %r" % args.source)
    after = to_ms(args.after) if args.after else None
    try:
        emit(read_session(cfg, args.source, args.ref, after, args.context_turns,
                          args.include_sidechains, machine))
    except (RuntimeError, OSError) as exc:
        die(str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
