#!/usr/bin/env python3
"""Machine-local environment discovery with cheap staleness checks.

  environment.py discover [--write]   inspect read-only; optionally cache facts
  environment.py check                report cached facts whose inputs changed
  environment.py skills               inventory installed skills with content hashes

Facts describe where things are (transcripts, instruction files, skill roots, which
copy is canonical) — never credentials. Each fact carries a stamp over the paths it
depends on, so freshness is judged by change, not age. Cached facts live in the
state directory and are never copied into the shared record.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wr_common import emit, iso, load_config, now_ms, state_dir  # noqa: E402

HOME = Path.home()
INSTRUCTION_CANDIDATES = [
    "~/.agents/AGENTS.md", "~/.claude/CLAUDE.md", "~/.codex/AGENTS.md",
    "~/.config/opencode/AGENTS.md",
]
SKILL_ROOTS = ["~/.agents/skills", "~/.claude/skills", "~/.config/opencode/skills"]
PLUGIN_ROOT_GLOBS = ["~/.agents/plugins/*/skills", "~/.claude/plugins/*/skills"]


def _x(path: str) -> Path:
    return Path(path).expanduser()


def stamp(paths) -> str:
    parts = []
    for p in sorted(str(x) for x in paths):
        path = Path(p)
        try:
            st = path.lstat()
            link = os.readlink(p) if path.is_symlink() else ""
            parts.append("%s|%d|%d|%s" % (p, st.st_mtime_ns, st.st_size, link))
        except OSError:
            parts.append("%s|missing" % p)
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


def _sh(cmd, cwd=None):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10, cwd=cwd)
        return proc.returncode, proc.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def git_root(path: Path):
    rc, out = _sh(["git", "-C", str(path if path.is_dir() else path.parent), "rev-parse", "--show-toplevel"])
    return out if rc == 0 else None


def managed_by(path: Path, siblings):
    found = []
    candidates = [str(path)] + [str(s) for s in siblings]
    if shutil.which("yadm"):
        for c in candidates:
            rc, out = _sh(["yadm", "ls-files", "--", c])
            if rc == 0 and out:
                found.append("yadm")
                break
    if shutil.which("chezmoi"):
        rc, out = _sh(["chezmoi", "source-path", str(path)])
        if rc == 0 and out:
            found.append("chezmoi")
    return found


def discover_instructions(cfg):
    facts = []
    for raw in INSTRUCTION_CANDIDATES + list(cfg.get("instruction_paths", [])):
        path = _x(raw)
        if not path.exists() and not path.is_symlink():
            continue
        real = Path(os.path.realpath(path))
        siblings = sorted(path.parent.glob(path.name + "##*"))
        facts.append({
            "id": "instructions:%s" % raw,
            "kind": "instruction_file",
            "value": {
                "path": str(path), "canonical": str(real), "is_symlink": path.is_symlink(),
                "generated_from": [str(s) for s in siblings],
                "git_root": git_root(real), "managed_by": managed_by(path, siblings),
            },
            "watch": [str(path), str(real)] + [str(s) for s in siblings],
        })
    return facts


def skill_dirs(cfg):
    roots = [(r, _x(r)) for r in SKILL_ROOTS + list(cfg.get("skill_paths", []))]
    for pattern in PLUGIN_ROOT_GLOBS:
        for match in sorted(glob.glob(os.path.expanduser(pattern))):
            roots.append((match, Path(match)))
    return [(raw, p) for raw, p in roots if p.is_dir()]


def inventory_skills(cfg):
    out = []
    for raw, root in skill_dirs(cfg):
        for md in sorted(root.glob("*/SKILL.md")):
            real = Path(os.path.realpath(md))
            text = md.read_text(errors="replace")
            desc = re.search(r"^description:\s*(.+)$", text, re.M)
            out.append({
                "id": md.parent.name, "root": raw, "path": str(md), "canonical": str(real),
                "git_root": git_root(real), "hash": hashlib.sha256(text.encode()).hexdigest()[:16],
                "modified": iso(int(md.stat().st_mtime * 1000)),
                "description": (desc.group(1).strip()[:160] if desc else ""),
            })
    return out


def discover(cfg):
    facts = []
    for name, scfg in cfg["sources"].items():
        if name == "opencode":
            cmd = shutil.which(scfg["command"].split()[0])
            facts.append({"id": "source:opencode", "kind": "transcript_source",
                          "value": {"available": bool(cmd), "access": "local HTTP API via `api` subcommand"},
                          "watch": [cmd] if cmd else []})
        else:
            root = _x(scfg["root"])
            facts.append({"id": "source:%s" % name, "kind": "transcript_source",
                          "value": {"available": root.is_dir(), "root": str(root)}, "watch": [str(root)]})
    facts += discover_instructions(cfg)
    roots = skill_dirs(cfg)
    facts.append({"id": "skills:roots", "kind": "skill_roots",
                  "value": {"roots": [{"root": raw, "canonical": os.path.realpath(p), "git_root": git_root(p)}
                                      for raw, p in roots]},
                  "watch": [str(p) for _, p in roots]})
    p = cfg.get("persistence", {})
    facts.append({"id": "persistence", "kind": "persistence",
                  "value": {"backend": p.get("backend"), "host": p.get("host"), "title": p.get("title"),
                            "glab_installed": bool(shutil.which("glab"))},
                  "watch": [shutil.which("glab") or ""]})
    now = iso(now_ms())
    for fact in facts:
        fact["observed_at"] = now
        fact["stamp"] = stamp([w for w in fact["watch"] if w])
    return facts


def cache_path() -> Path:
    return state_dir() / "environment.json"


def check(cached):
    stale = []
    for fact in cached.get("facts", []):
        if stamp([w for w in fact.get("watch", []) if w]) != fact.get("stamp"):
            stale.append(fact["id"])
    return stale


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover")
    d.add_argument("--write", action="store_true")
    sub.add_parser("check")
    sub.add_parser("skills")
    a = ap.parse_args(argv)
    cfg = load_config()

    if a.cmd == "skills":
        emit({"skills": inventory_skills(cfg)})
        return 0
    if a.cmd == "discover":
        facts = discover(cfg)
        doc = {"observed_at": iso(now_ms()), "facts": facts}
        if a.write:
            cache_path().parent.mkdir(parents=True, exist_ok=True)
            cache_path().write_text(json.dumps(doc, indent=1) + "\n")
        emit(doc)
        return 0
    if not cache_path().exists():
        emit({"cached": False, "stale": [], "note": "no cached environment; run discover --write"})
        return 0
    cached = json.loads(cache_path().read_text())
    fresh_ids = {f["id"] for f in discover(cfg)}
    old_ids = {f["id"] for f in cached.get("facts", [])}
    emit({"cached": True, "observed_at": cached.get("observed_at"), "stale": check(cached),
          "new_facts": sorted(fresh_ids - old_ids), "vanished_facts": sorted(old_ids - fresh_ids)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
