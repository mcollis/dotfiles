#!/usr/bin/env python3
"""Review record: schema, privacy check, deterministic merge, coverage planning, rendering.

  record.py new
  record.py window  --scope general|focus:<text> [--record F] [--source S]... [--since T]
  record.py plan    --scope ... --inventory F [--record F] [--since T]
  record.py coverage-entry --plan F --source S [--reviewed F] [--gap TEXT]...
  record.py check   DELTA [--mode interactive|headless]
  record.py merge   --record F --delta F [--mode ...]      -> {record, report}
  record.py render  --record F [--limit N]
  record.py overview --record F [--limit N]

The record holds only sanitized workflow lessons. Raw transcript text, identifiers,
paths, URLs, quotations and credentials are rejected by `check` before anything is
merged or persisted.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wr_common import (  # noqa: E402
    die, emit, iso, load_config, machine_id, now_ms, to_ms,
)

SCHEMA = 1
CLASSES = ["repeated_correction", "manual_effort", "high_impact", "opportunity"]
IMPACT = ["high", "medium", "low"]
CONFIDENCE = ["high", "medium", "low"]
CAUSES = [
    "missing_guidance", "not_loaded", "ignored_guidance", "invented_constraint",
    "scope_drift", "tool_failure", "poor_output", "over_complexity",
    "manual_workflow", "other",
]
STATES = ["open", "deferred", "planned", "implemented", "validated", "dismissed"]
RESOLVED = ("implemented", "validated", "dismissed")
PROFILE_STATUS = ["explicit", "confirmed", "tentative"]
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{2,60}$")
SID = re.compile(r"^[0-9a-f]{16}$")

# --------------------------------------------------------------------------
# Privacy
# --------------------------------------------------------------------------

SECRET = re.compile(
    r"glpat-[A-Za-z0-9_-]{10,}|gh[oprsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}"
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"
)
EXEMPT_NAMES = re.compile(r"\b(?:SKILL|AGENTS|CLAUDE|README)\.md\b")
RULES = [
    ("url", re.compile(r"https?://|\bwww\.", re.I)),
    ("email", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")),
    ("ticket_key", re.compile(r"\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b")),
    ("review_ref", re.compile(r"(?<![\w])[!#]\d{2,7}\b")),
    ("absolute_path", re.compile(r"(?:^|[\s(`'\"])(?:~|/(?:Users|home|opt|var|etc|private|tmp|mnt|srv|usr)\b)[^\s]*|\b[A-Za-z]:\\")),
    ("relative_path", re.compile(r"\b[\w.-]+(?:/[\w.-]+){2,}\b|\b[\w-]+/[\w-]+\.[A-Za-z0-9]{1,6}\b")),
    ("filename", re.compile(r"\b[\w-]+\.(?:tsx?|jsx?|py|go|rs|java|kt|cc?|cpp|hpp?|scss|css|json|ya?ml|toml|sh|md|sql|proto|html|txt|lock|rb|swift)\b")),
    ("hostname", re.compile(r"\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b|\blocalhost:\d+|\b\d{1,3}(?:\.\d{1,3}){3}\b", re.I)),
    ("commit_hash", re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b")),
    ("secret", SECRET),
    ("code_fence", re.compile(r"```")),
    ("long_quotation", re.compile(r"[\"“][^\"”\n]{40,}[\"”]")),
]
INLINE_CODE = re.compile(r"`([^`\n]*)`")
SIMPLE_NAME = re.compile(r"^[a-z][a-z0-9-]{0,40}$")
SKIP_KEYS = {
    "sid", "sids", "machine", "source", "schema", "status", "state", "kind", "category",
    "class", "impact", "confidence", "at", "from", "to", "by", "sessions", "revision",
    "complete", "from_ms", "to_ms", "mode", "finding", "reviewed_at", "target_rev",
}
IDENT_KEYS = {"id", "key"}


def _scan_text(text: str, deny_terms, deny_patterns):
    hits = []
    cleaned = EXEMPT_NAMES.sub("", text)
    for name, rx in RULES:
        if rx.search(cleaned):
            hits.append(name)
    for span in INLINE_CODE.findall(cleaned):
        if not SIMPLE_NAME.match(span):
            hits.append("inline_code")
            break
    low = cleaned.lower()
    for term in deny_terms:
        if term and term.lower() in low:
            hits.append("denied_term")
            break
    for pattern in deny_patterns:
        try:
            if re.search(pattern, cleaned, re.I):
                hits.append("denied_pattern")
                break
        except re.error:
            hits.append("invalid_deny_pattern")
    return hits


def privacy_violations(delta, cfg=None):
    """Returns [{path, rule}] — never the matched text."""
    cfg = cfg or load_config()
    terms = cfg["privacy"].get("deny_terms", [])
    patterns = cfg["privacy"].get("deny_patterns", [])
    found = []

    def walk(value, path, key):
        if key in SKIP_KEYS:
            return
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, "%s.%s" % (path, k) if path else str(k), k)
        elif isinstance(value, list):
            for i, v in enumerate(value):
                walk(v, "%s[%d]" % (path, i), key)
        elif isinstance(value, str):
            if key in IDENT_KEYS:
                if re.search(r"\b[a-z][a-z0-9]{1,9}-\d{2,7}\b", value):
                    found.append({"path": path, "rule": "ticket_key"})
                if SECRET.search(value):
                    found.append({"path": path, "rule": "secret"})
                return
            for rule in _scan_text(value, terms, patterns):
                found.append({"path": path, "rule": rule})

    walk(delta, "", None)
    return found


# --------------------------------------------------------------------------
# Record
# --------------------------------------------------------------------------

def new_record() -> dict:
    return {
        "schema": SCHEMA, "revision": 0, "updated": None,
        "profile": {"entries": []},
        "coverage": [], "findings": [], "reviews": [],
        "withheld": {"count": 0, "classes": {}},
    }


def check_record(record) -> None:
    if not isinstance(record, dict) or record.get("schema") != SCHEMA:
        raise ValueError("unsupported or missing record schema (expected %d); needs Plan reconciliation" % SCHEMA)
    for key in ("profile", "coverage", "findings", "reviews", "withheld"):
        if key not in record:
            raise ValueError("record is missing %r; needs Plan reconciliation" % key)


def _oneof(value, allowed, label, errors, optional=False):
    if value is None and optional:
        return
    if value not in allowed:
        errors.append("%s must be one of %s" % (label, "/".join(allowed)))


def _timestamp(value, label, errors):
    try:
        to_ms(value)
    except (ValueError, TypeError):
        errors.append("%s must be an ISO-8601 time" % label)


def validate_delta(delta, mode: str):
    errors = []
    if not isinstance(delta, dict):
        return ["delta must be a JSON object"]
    allowed = {"at", "review", "coverage", "profile", "profile_remove", "findings",
               "decisions", "withheld"}
    for key in delta:
        if key not in allowed:
            errors.append("unknown delta field %r" % key)
    if mode == "headless":
        for key in ("decisions", "profile_remove"):
            if delta.get(key):
                errors.append("%s is not allowed in headless mode" % key)
    for i, e in enumerate(delta.get("profile") or []):
        p = "profile[%d]" % i
        if not SLUG.match(str(e.get("id", ""))):
            errors.append("%s.id must be a lowercase slug" % p)
        for f in ("text", "scope"):
            if not e.get(f):
                errors.append("%s.%s is required" % (p, f))
        _oneof(e.get("status"), PROFILE_STATUS, p + ".status", errors)
        if mode == "headless" and e.get("status") != "tentative":
            errors.append("%s: headless runs may only record tentative preferences" % p)
    for i, e in enumerate(delta.get("findings") or []):
        p = "findings[%d]" % i
        ident = e.get("id") or ("f-" + str(e.get("key", "")))
        if not SLUG.match(ident):
            errors.append("%s needs a slug id or key" % p)
        _oneof(e.get("class"), CLASSES, p + ".class", errors, optional=True)
        _oneof(e.get("category"), CAUSES, p + ".category", errors, optional=True)
        _oneof(e.get("impact"), IMPACT, p + ".impact", errors, optional=True)
        _oneof(e.get("confidence"), CONFIDENCE, p + ".confidence", errors, optional=True)
        for ev in (e.get("evidence") or []) + (e.get("counter_evidence") or []):
            if not SID.match(str(ev.get("sid", ""))):
                errors.append("%s evidence needs an opaque 16-hex sid" % p)
            if not ev.get("note"):
                errors.append("%s evidence needs a sanitized note" % p)
            _timestamp(ev.get("at"), p + ".evidence.at", errors)
    for i, d in enumerate(delta.get("decisions") or []):
        _oneof(d.get("state"), STATES, "decisions[%d].state" % i, errors)
        if not d.get("id"):
            errors.append("decisions[%d].id is required" % i)
    for i, c in enumerate(delta.get("coverage") or []):
        p = "coverage[%d]" % i
        for f in ("source", "machine", "scope", "from_ms", "to_ms", "complete"):
            if f not in c:
                errors.append("%s.%s is required" % (p, f))
        if (c.get("scope") or {}).get("kind") not in ("general", "focus"):
            errors.append("%s.scope.kind must be general or focus" % p)
    return errors


def _scope_key(scope):
    return (scope.get("kind"), (scope.get("focus") or "").strip().lower())


def _dedupe(items, key):
    seen, out = set(), []
    for item in items:
        k = key(item)
        if k not in seen:
            seen.add(k)
            out.append(item)
    return out


def _merge_profile(rec, e, mode, now, report):
    entries = rec["profile"]["entries"]
    cur = next((x for x in entries if x["id"] == e["id"]), None)
    if cur is None:
        entries.append({
            "id": e["id"], "text": e["text"], "scope": e["scope"], "status": e["status"],
            "rationale": e.get("rationale", ""), "first_observed": now, "last_observed": now,
            "observations": 1, "by": e.get("by") or ("user" if e["status"] != "tentative" else "agent"),
            "contradictions": [],
        })
        report["profile_added"].append(e["id"])
        return
    cur["last_observed"] = now
    cur["observations"] = cur.get("observations", 1) + 1
    if e["status"] == "tentative" and cur["status"] != "tentative":
        if e["text"] != cur["text"]:
            cur["contradictions"] = _dedupe(
                (cur.get("contradictions") or []) + [{"text": e["text"], "at": now}],
                lambda c: c["text"])[-5:]
            report["profile_contradictions"].append(e["id"])
        return
    cur.update({"text": e["text"], "scope": e["scope"], "status": e["status"],
                "rationale": e.get("rationale", cur.get("rationale", ""))})
    if e["status"] != "tentative":
        cur["by"] = e.get("by") or "user"
        cur["contradictions"] = []
    report["profile_updated"].append(e["id"])


def _merge_finding(rec, e, now, report):
    fid = e.get("id") or "f-" + e["key"]
    cur = next((x for x in rec["findings"] if x["id"] == fid), None)
    evidence = e.get("evidence") or []
    latest = max([ev["at"] for ev in evidence], key=to_ms, default=now)
    if cur is None:
        for f in ("title", "summary", "class", "category"):
            if not e.get(f):
                raise ValueError("new finding %s requires %s" % (fid, f))
        cur = {
            "id": fid, "title": e["title"], "summary": e["summary"], "class": e["class"],
            "category": e["category"], "impact": e.get("impact", "medium"),
            "confidence": e.get("confidence", "medium"), "cause": e.get("cause", ""),
            "proposal": e.get("proposal", ""), "target": e.get("target", ""),
            "target_rev": e.get("target_rev", ""),
            "state": "open", "first_seen": latest, "last_seen": latest, "state_changed_at": now,
            "sids": [], "evidence": [], "counter_evidence": [], "questions": [], "decisions": [],
            "recurrence": 0, "recurred_after_resolution": 0,
        }
        rec["findings"].append(cur)
        report["findings_added"].append(fid)
    else:
        if cur["state"] in ("open", "deferred"):
            for f in ("title", "summary", "class", "category", "impact", "confidence",
                      "cause", "proposal", "target", "target_rev"):
                if e.get(f):
                    cur[f] = e[f]
        else:
            ignored = [f for f in ("title", "summary", "class", "category", "impact",
                                   "confidence", "cause", "proposal", "target", "target_rev")
                       if e.get(f) and e[f] != cur.get(f)]
            if ignored:
                report["findings_ignored_fields"].append({"id": fid, "fields": ignored})
        report["findings_updated"].append(fid)
        if to_ms(latest) > to_ms(cur["last_seen"]):
            cur["last_seen"] = latest
    changed = to_ms(cur["state_changed_at"])
    for ev in evidence:
        if ev["sid"] not in cur["sids"]:
            cur["sids"].append(ev["sid"])
            if cur["state"] in RESOLVED and to_ms(ev["at"]) > changed:
                cur["recurred_after_resolution"] += 1
                if fid not in report["recurred"]:
                    report["recurred"].append(fid)
    cur["sids"].sort()
    cur["evidence"] = _dedupe(cur["evidence"] + [
        {"sid": ev["sid"], "note": ev["note"], "at": ev["at"]} for ev in evidence],
        lambda x: (x["sid"], x["note"]))
    cur["evidence"] = sorted(cur["evidence"], key=lambda x: to_ms(x["at"]))[-12:]
    cur["counter_evidence"] = sorted(_dedupe(cur["counter_evidence"] + [
        {"sid": ev["sid"], "note": ev["note"], "at": ev["at"]} for ev in e.get("counter_evidence") or []],
        lambda x: (x["sid"], x["note"])), key=lambda x: to_ms(x["at"]))[-6:]
    cur["questions"] = _dedupe(cur["questions"] + list(e.get("questions") or []), lambda q: q)[-6:]
    cur["recurrence"] = len(cur["sids"])


def _merge_coverage(rec, c):
    entry = {
        "source": c["source"], "machine": c["machine"], "scope": c["scope"],
        "from_ms": int(c["from_ms"]), "to_ms": int(c["to_ms"]), "complete": bool(c["complete"]),
        "sessions": c.get("sessions") or {}, "gaps": list(c.get("gaps") or []),
        "reviewed_at": c.get("reviewed_at") or iso(now_ms()),
    }
    rec["coverage"].append(entry)
    if entry["complete"]:
        for old in rec["coverage"][:-1]:
            if (not old["complete"] and old["source"] == entry["source"]
                    and old["machine"] == entry["machine"]
                    and _scope_key(old["scope"]) == _scope_key(entry["scope"])
                    and old["to_ms"] <= entry["to_ms"] and entry["from_ms"] <= old["from_ms"]):
                old["sessions"] = {}
                old["compacted"] = True


def merge(record, delta, mode="interactive", now=None):
    check_record(record)
    errors = validate_delta(delta, mode)
    if errors:
        raise ValueError("invalid delta: " + "; ".join(errors))
    now = now or delta.get("at") or iso(now_ms())
    rec = copy.deepcopy(record)
    report = {k: [] for k in (
        "profile_added", "profile_updated", "profile_contradictions", "findings_added",
        "findings_updated", "findings_ignored_fields", "recurred", "decisions_applied")}

    for e in delta.get("profile") or []:
        _merge_profile(rec, e, mode, now, report)
    for pid in delta.get("profile_remove") or []:
        rec["profile"]["entries"] = [x for x in rec["profile"]["entries"] if x["id"] != pid]
    for e in delta.get("findings") or []:
        _merge_finding(rec, e, now, report)
    for d in delta.get("decisions") or []:
        cur = next((x for x in rec["findings"] if x["id"] == d["id"]), None)
        if cur is None:
            raise ValueError("decision references unknown finding %s" % d["id"])
        cur["state"] = d["state"]
        cur["state_changed_at"] = now
        cur["decisions"].append({"at": now, "state": d["state"], "note": d.get("note", "")})
        report["decisions_applied"].append(d["id"])
    for c in delta.get("coverage") or []:
        _merge_coverage(rec, c)
    if delta.get("review"):
        review = dict(delta["review"])
        review.setdefault("at", now)
        review.setdefault("mode", mode)
        rec["reviews"] = (rec["reviews"] + [review])[-50:]
    for w in delta.get("withheld") or []:
        rec["withheld"]["count"] += 1
        cls = str(w.get("class", "other")) if isinstance(w, dict) else "other"
        rec["withheld"]["classes"][cls] = rec["withheld"]["classes"].get(cls, 0) + 1
    rec["revision"] += 1
    rec["updated"] = now
    return rec, report


# --------------------------------------------------------------------------
# Coverage planning
# --------------------------------------------------------------------------

def _parse_scope(text: str) -> dict:
    if text == "general":
        return {"kind": "general"}
    if text.startswith("focus:") and text[6:].strip():
        return {"kind": "focus", "focus": text[6:].strip()}
    die("--scope must be 'general' or 'focus:<text>'")


def _applicable(rec, scope, source, machine):
    out = []
    for c in rec["coverage"]:
        if not c["complete"] or c["source"] != source or c["machine"] != machine:
            continue
        if c["scope"]["kind"] == "general" or _scope_key(c["scope"]) == _scope_key(scope):
            out.append(c)
    return out


def frontier(intervals):
    """Contiguous covered end, plus holes. Non-contiguous reviews never advance it."""
    if not intervals:
        return None, []
    ordered = sorted(intervals, key=lambda c: c["from_ms"])
    end, holes = ordered[0]["to_ms"], []
    for c in ordered[1:]:
        if c["from_ms"] <= end:
            end = max(end, c["to_ms"])
        else:
            holes.append({"from_ms": end, "to_ms": c["from_ms"]})
    return end, holes


def window(rec, scope, sources, machine, now, default_days, explicit_since=None):
    per = {}
    for src in sources:
        end, holes = frontier(_applicable(rec, scope, src, machine))
        if explicit_since is not None:
            since, basis = explicit_since, "explicit"
        elif end is not None:
            since, basis = end, "coverage"
        else:
            since, basis = now - default_days * 86400 * 1000, "default"
        per[src] = {"since_ms": since, "basis": basis, "since": iso(since), "holes": holes}
    return {"scope": scope, "machine": machine, "now_ms": now, "per_source": per,
            "min_since_ms": min(v["since_ms"] for v in per.values()) if per else now}


def plan(rec, scope, inventory, machine, default_days, explicit_since=None):
    sources = list(inventory["sources"])
    now = inventory["window"]["until_ms"]
    win = window(rec, scope, sources, machine, now, default_days, explicit_since)
    out = {"scope": scope, "machine": machine, "until_ms": now, "per_source": {}}
    children = {}
    for kid in inventory.get("children", []):
        if kid.get("parent_sid"):
            children[kid["parent_sid"]] = children.get(kid["parent_sid"], 0) + 1
    for src, info in inventory["sources"].items():
        since = win["per_source"][src]["since_ms"]
        reviewed = {}
        for c in rec["coverage"]:
            if (not c["complete"] and c["source"] == src and c["machine"] == machine
                    and _scope_key(c["scope"]) == _scope_key(scope)):
                reviewed.update(c.get("sessions") or {})
        examine, skipped = [], 0
        for s in inventory["sessions"]:
            if s["source"] != src or s["updated_ms"] < since:
                continue
            seen = reviewed.get(s["sid"])
            if seen is not None and seen >= s["updated_ms"]:
                skipped += 1
                continue
            if seen is not None:
                after, reason = seen, "new_activity"
            elif s["created_ms"] < since:
                after, reason = since, "new_activity"
            else:
                after, reason = None, "new"
            examine.append({
                "source": src, "ref": s["ref"], "sid": s["sid"], "title": s.get("title", ""),
                "cwd": s.get("cwd"), "updated_ms": s["updated_ms"], "after_ms": after,
                "reason": reason, "child_sessions": children.get(s["sid"], 0),
            })
        out["per_source"][src] = {
            "status": info.get("status"), "completable": info.get("status") == "ok",
            "since_ms": since, "basis": win["per_source"][src]["basis"],
            "holes": win["per_source"][src]["holes"],
            "skipped_already_reviewed": skipped, "examine": examine,
        }
    return out


def coverage_entry(plan_doc, source, reviewed_sids, gaps):
    info = plan_doc["per_source"][source]
    wanted = {e["sid"]: e["updated_ms"] for e in info["examine"]}
    done = {sid: wanted[sid] for sid in reviewed_sids if sid in wanted}
    complete = info["completable"] and len(done) == len(wanted)
    gaps = list(gaps)
    if not info["completable"]:
        gaps.append("source unavailable during inventory")
    if len(done) < len(wanted):
        gaps.append("%d of %d sessions not examined" % (len(wanted) - len(done), len(wanted)))
    return {
        "source": source, "machine": plan_doc["machine"], "scope": plan_doc["scope"],
        "from_ms": info["since_ms"], "to_ms": plan_doc["until_ms"], "complete": complete,
        "sessions": {} if complete else done, "gaps": gaps, "reviewed_at": iso(now_ms()),
    }


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def _rank(f):
    return (f["state"] == "deferred", CLASSES.index(f["class"]), IMPACT.index(f["impact"]),
            -f["recurrence"], -to_ms(f["last_seen"]))


def _line(f):
    tags = [f["class"].replace("_", " "), f["impact"] + " impact", "%d session%s" % (f["recurrence"], "" if f["recurrence"] == 1 else "s")]
    if f["recurred_after_resolution"]:
        tags.append("RECURRED after %s" % f["state"])
    if f["confidence"] == "low":
        tags.append("low confidence")
    return "**%s** — %s" % (f["title"], ", ".join(tags))


def render(rec, limit=5) -> str:
    active = [f for f in rec["findings"] if f["state"] in ("open", "deferred")]
    recurred = [f for f in rec["findings"] if f["state"] in RESOLVED and f["recurred_after_resolution"]]
    ranked = sorted(recurred, key=_rank) + sorted(active, key=_rank)
    head, rest = ranked[:limit], ranked[limit:]
    progress = [f for f in rec["findings"] if f["state"] in ("planned", "implemented")]
    lines = ["# Workflow retrospective", "",
             "_Revision %d · updated %s_" % (rec["revision"], rec["updated"] or "never"), ""]
    lines.append("## Headline findings")
    if not head:
        lines.append("_None open._")
    for n, f in enumerate(head, 1):
        lines.append("%d. %s" % (n, _line(f)))
        if f.get("proposal"):
            lines.append("   Direction: %s" % f["proposal"])
        if f["questions"]:
            lines.append("   Open question: %s" % f["questions"][-1])
    if rest:
        lines += ["", "## Remaining backlog"]
        lines += ["- [%s] %s" % (f["state"], _line(f)) for f in rest]
    if progress:
        lines += ["", "## Planned or awaiting validation"]
        lines += ["- [%s] %s" % (f["state"], _line(f)) for f in progress]
    dismissed = sum(1 for f in rec["findings"] if f["state"] == "dismissed")
    validated = sum(1 for f in rec["findings"] if f["state"] == "validated")
    lines += ["", "## Status",
              "- %d validated, %d dismissed, %d withheld for privacy" % (validated, dismissed, rec["withheld"]["count"])]
    lines += ["", "## Coverage"]
    groups = {}
    for c in rec["coverage"]:
        groups.setdefault((c["source"], c["scope"]["kind"], (c["scope"].get("focus") or "")), []).append(c)
    if not groups:
        lines.append("_No reviews recorded._")
    for (src, kind, focus), items in sorted(groups.items()):
        done = [c for c in items if c["complete"]]
        label = kind if not focus else "%s: %s" % (kind, focus)
        last = max((c["to_ms"] for c in done), default=None)
        partial = sum(1 for c in items if not c["complete"] and not c.get("compacted"))
        lines.append("- %s / %s: complete through %s%s" % (
            src, label, iso(last) if last else "never", ", %d partial" % partial if partial else ""))
    entries = rec["profile"]["entries"]
    lines += ["", "## Profile (%d entries, %d tentative)" % (
        len(entries), sum(1 for e in entries if e["status"] == "tentative"))]
    for e in entries:
        mark = {"explicit": "stated", "confirmed": "confirmed", "tentative": "tentative"}[e["status"]]
        extra = " — contradicted" if e.get("contradictions") else ""
        lines.append("- [%s] (%s) %s%s" % (mark, e["scope"], e["text"], extra))
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _load(path):
    if path in (None, ""):
        return None
    try:
        return json.loads(sys.stdin.read() if path == "-" else Path(path).read_text())
    except (OSError, ValueError) as exc:
        die("cannot read %s: %s" % (path, exc))


def dump_record(rec) -> str:
    return json.dumps(rec, ensure_ascii=False, indent=1, sort_keys=True) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("new")
    w = sub.add_parser("window")
    p = sub.add_parser("plan")
    for s in (w, p):
        s.add_argument("--scope", default="general")
        s.add_argument("--record")
        s.add_argument("--since")
        s.add_argument("--machine")
    w.add_argument("--source", action="append")
    p.add_argument("--inventory", required=True)
    ce = sub.add_parser("coverage-entry")
    ce.add_argument("--plan", required=True)
    ce.add_argument("--source", required=True)
    ce.add_argument("--reviewed")
    ce.add_argument("--gap", action="append", default=[])
    ck = sub.add_parser("check")
    ck.add_argument("delta")
    ck.add_argument("--mode", default="interactive", choices=["interactive", "headless"])
    mg = sub.add_parser("merge")
    mg.add_argument("--record", required=True)
    mg.add_argument("--delta", required=True)
    mg.add_argument("--mode", default="interactive", choices=["interactive", "headless"])
    for name in ("render", "overview"):
        r = sub.add_parser(name)
        r.add_argument("--record", required=True)
        r.add_argument("--limit", type=int, default=5)
    a = ap.parse_args(argv)
    cfg = load_config()

    if a.cmd == "new":
        sys.stdout.write(dump_record(new_record()))
        return 0
    if a.cmd in ("window", "plan"):
        rec = _load(a.record) or new_record()
        try:
            check_record(rec)
        except ValueError as exc:
            die(str(exc))
        scope = _parse_scope(a.scope)
        machine = a.machine or machine_id()
        since = to_ms(a.since) if a.since else None
        if a.cmd == "window":
            srcs = a.source or [n for n, c in cfg["sources"].items() if c.get("enabled") is not False]
            emit(window(rec, scope, srcs, machine, now_ms(), cfg["default_window_days"], since))
        else:
            emit(plan(rec, scope, _load(a.inventory), machine, cfg["default_window_days"], since))
        return 0
    if a.cmd == "coverage-entry":
        reviewed = _load(a.reviewed) if a.reviewed else []
        emit(coverage_entry(_load(a.plan), a.source, reviewed, a.gap))
        return 0
    if a.cmd == "check":
        delta = _load(a.delta)
        errors = validate_delta(delta, a.mode)
        hits = privacy_violations(delta, cfg)
        if errors or hits:
            emit({"ok": False, "errors": errors, "privacy": hits})
            return 1
        emit({"ok": True})
        return 0
    if a.cmd == "merge":
        delta = _load(a.delta)
        hits = privacy_violations(delta, cfg)
        if hits:
            emit({"ok": False, "privacy": hits})
            return 1
        try:
            rec, report = merge(_load(a.record), delta, a.mode)
        except ValueError as exc:
            die(str(exc))
        emit({"record": rec, "report": report})
        return 0
    rec = _load(a.record)
    try:
        check_record(rec)
    except ValueError as exc:
        die(str(exc))
    sys.stdout.write(render(rec, a.limit))
    return 0


if __name__ == "__main__":
    sys.exit(main())
