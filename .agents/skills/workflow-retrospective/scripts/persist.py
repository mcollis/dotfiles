#!/usr/bin/env python3
"""Private GitLab-snippet persistence for the review record.

  persist.py status
  persist.py init --confirmed       create the private snippet (explicit user go-ahead only)
  persist.py read                   print the stored record JSON
  persist.py save --delta F [--mode interactive|headless]
  persist.py flush                  retry deltas queued after a failed save

Design constraints:
  * Visibility is verified to be `private` before and after every operation; the
    adapter never widens or changes visibility and never writes through the API
    except for the one-time create.
  * Updates are plain `git push` to the snippet repository (no force). A competing
    update triggers a fresh clone and a re-merge of the same delta (max 2 retries),
    so concurrent runs never replace the whole record.
  * A failed lookup is "unknown", never "absent".
  * Stored write credentials (the glab fallback) are used for `init` only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wr_common import die, emit, iso, load_config, now_ms, state_dir  # noqa: E402
from record import (  # noqa: E402
    SECRET, dump_record, merge, new_record, privacy_violations, render, validate_delta,
)

MAX_RETRIES = 2
FILE_JSON = "workflow-retrospective.json"
FILE_MD = "workflow-retrospective.md"


class PersistError(Exception):
    pass


def _run(cmd, env=None, input_text=None, cwd=None):
    return subprocess.run(cmd, capture_output=True, text=True, env=env, input=input_text, cwd=cwd, timeout=180)


def _parse_stream(text: str):
    """glab --paginate emits concatenated JSON arrays."""
    decoder, pos, out = json.JSONDecoder(), 0, []
    text = text.strip()
    while pos < len(text):
        value, end = decoder.raw_decode(text, pos)
        out.extend(value if isinstance(value, list) else [value])
        pos = end
        while pos < len(text) and text[pos].isspace():
            pos += 1
    return out


class GitLabSnippetStore:
    def __init__(self, cfg: dict, run=_run, remote_override=None, before_push=None):
        p = cfg["persistence"]
        self.host = p.get("host")
        if not self.host:
            raise PersistError("persistence.host is not configured (see references/config.md)")
        self.title = p.get("title", "workflow-retrospective")
        self.cfg = cfg
        self.run = run
        self.remote_override = remote_override
        self.before_push = before_push
        self.lock_dir = state_dir() / "locks" / "save.lock"

    # -- API ---------------------------------------------------------------

    def _api(self, args, write=False, input_text=None):
        env = dict(os.environ)
        if write:
            for name in ("GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"):
                env.pop(name, None)
        proc = self.run(["glab", "api", "--hostname", self.host] + args, env=env, input_text=input_text)
        if proc.returncode != 0:
            raise PersistError("glab api failed: %s" % proc.stderr.strip()[:300])
        return proc.stdout

    def lookup(self):
        """None when absent. Raises on any failure, duplicate, or non-private match."""
        try:
            rows = _parse_stream(self._api(["--paginate", "snippets?per_page=100"]))
        except ValueError:
            raise PersistError("snippet lookup returned unparseable output; treating as unknown")
        wanted = self.title.strip().lower()
        hits = [r for r in rows if (r.get("title") or "").strip().lower() == wanted]
        if not hits:
            return None
        if len(hits) > 1:
            raise PersistError("%d snippets titled %r (ids %s); resolve the duplicate manually" % (
                len(hits), self.title, ", ".join(str(h["id"]) for h in hits)))
        hit = hits[0]
        if hit.get("visibility") != "private":
            raise PersistError("snippet %s is %r, not private; refusing to use it. "
                               "Fix its visibility manually or choose another title." % (
                                   hit["id"], hit.get("visibility")))
        return hit

    def create(self):
        record = new_record()
        payload = {
            "title": self.title, "visibility": "private",
            "description": "Maintained by the workflow-retrospective skill.",
            "files": [{"file_path": FILE_JSON, "content": dump_record(record)},
                      {"file_path": FILE_MD, "content": render(record)}],
        }
        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            os.chmod(path, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump(payload, handle)
            out = self._api(["--method", "POST", "snippets", "--input", path,
                             "--header", "Content-Type: application/json"], write=True)
        finally:
            os.unlink(path)
        created = json.loads(out)
        if created.get("visibility") != "private":
            raise PersistError("created snippet %s is %r, not private; fix it manually now" % (
                created.get("id"), created.get("visibility")))
        return created

    # -- git ---------------------------------------------------------------

    def _git_env(self):
        env = dict(os.environ)
        env["GIT_TERMINAL_PROMPT"] = "0"
        env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        return env

    def _git(self, args, cwd=None, check=True):
        proc = self.run(["git"] + args, env=self._git_env(), cwd=cwd)
        if check and proc.returncode != 0:
            raise PersistError("git %s failed: %s" % (args[0], proc.stderr.strip()[:300]))
        return proc

    def _remote(self, info):
        return self.remote_override or info.get("ssh_url_to_repo") or info.get("http_url_to_repo")

    def _clone(self, info, dest):
        url = self._remote(info)
        if not url:
            raise PersistError("snippet exposes no repository URL")
        self._git(["clone", "--quiet", url, str(dest)])

    def _identity(self, repo):
        have = self._git(["config", "user.email"], cwd=str(repo), check=False).stdout.strip()
        return [] if have else ["-c", "user.name=workflow-retrospective",
                                "-c", "user.email=workflow-retrospective@localhost"]

    # -- operations ----------------------------------------------------------

    def read(self):
        info = self.lookup()
        if info is None:
            raise PersistError("no record exists; run `init` first")
        tmp = Path(tempfile.mkdtemp(prefix="wr-read-"))
        try:
            self._clone(info, tmp / "repo")
            path = tmp / "repo" / FILE_JSON
            if not path.exists():
                raise PersistError("%s missing from the snippet; needs Plan reconciliation" % FILE_JSON)
            return json.loads(path.read_text()), info
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def save(self, delta: dict, mode: str):
        limits = self.cfg["limits"]
        info = self.lookup()
        if info is None:
            raise PersistError("no record exists; run `init` first")
        last = None
        for attempt in range(MAX_RETRIES + 1):
            tmp = Path(tempfile.mkdtemp(prefix="wr-save-"))
            try:
                repo = tmp / "repo"
                self._clone(info, repo)
                path = repo / FILE_JSON
                if not path.exists():
                    raise PersistError("%s missing from the snippet; needs Plan reconciliation" % FILE_JSON)
                try:
                    current = json.loads(path.read_text())
                    merged, report = merge(current, delta, mode)
                except ValueError as exc:
                    raise PersistError(str(exc))
                body = dump_record(merged)
                if len(body.encode()) > limits["max_record_bytes"]:
                    raise PersistError("record would exceed %d bytes; archive or prune with Plan before saving" %
                                       limits["max_record_bytes"])
                warnings = []
                if len(body.encode()) > limits["warn_record_bytes"]:
                    warnings.append("record is %d bytes; consider compacting" % len(body.encode()))
                if SECRET.search(body):
                    raise PersistError("merged record matches a credential-like pattern; refusing to save")
                path.write_text(body)
                (repo / FILE_MD).write_text(render(merged))
                self._git(["add", FILE_JSON, FILE_MD], cwd=str(repo))
                msg = "workflow-retrospective: revision %d" % merged["revision"]
                self._git(self._identity(repo) + ["commit", "--quiet", "-m", msg], cwd=str(repo))
                if self.before_push:
                    self.before_push(attempt)
                push = self._git(["push", "--quiet", "origin", "HEAD"], cwd=str(repo), check=False)
                if push.returncode == 0:
                    after = self.lookup()
                    return {"result": "SAVED", "revision": merged["revision"], "id": info["id"],
                            "url": (after or info).get("web_url"), "attempts": attempt + 1,
                            "report": report, "warnings": warnings}
                last = push.stderr.strip()[:300]
                if not any(t in push.stderr for t in ("rejected", "non-fast-forward", "fetch first", "stale info")):
                    raise PersistError("git push failed: %s" % last)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        raise PersistError("update conflicted %d times; stopping without overwriting (%s)" % (MAX_RETRIES + 1, last))

    # -- locking -----------------------------------------------------------

    def acquire(self, timeout=30):
        self.lock_dir.parent.mkdir(parents=True, exist_ok=True)
        waited = 0.0
        while True:
            try:
                self.lock_dir.mkdir()
                return
            except FileExistsError:
                try:
                    if time.time() - self.lock_dir.stat().st_mtime > 120:
                        self.lock_dir.rmdir()
                        continue
                except OSError:
                    pass
                if waited > timeout:
                    raise PersistError("another save is in progress or stuck")
                time.sleep(0.2)
                waited += 0.2

    def release(self):
        try:
            self.lock_dir.rmdir()
        except OSError:
            pass


# --------------------------------------------------------------------------
# Outbox (sanitized deltas only)
# --------------------------------------------------------------------------

def outbox_dir() -> Path:
    return state_dir() / "outbox"


def queue(delta: dict, mode: str) -> Path:
    outbox_dir().mkdir(parents=True, exist_ok=True)
    body = json.dumps({"mode": mode, "delta": delta}, sort_keys=True)
    path = outbox_dir() / ("%d-%s.json" % (now_ms(), hashlib.sha256(body.encode()).hexdigest()[:8]))
    path.write_text(body)
    return path


def pending():
    return sorted(outbox_dir().glob("*.json")) if outbox_dir().exists() else []


def checked_delta(path: str, mode: str, cfg: dict) -> dict:
    try:
        delta = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        die("cannot read delta: %s" % exc)
    errors = validate_delta(delta, mode)
    hits = privacy_violations(delta, cfg)
    if errors or hits:
        emit({"result": "REJECTED", "errors": errors, "privacy": hits})
        sys.exit(1)
    return delta


def save_with_outbox(store, delta, mode):
    store.acquire()
    try:
        return store.save(delta, mode)
    except PersistError as exc:
        queued = queue(delta, mode)
        raise PersistError("NOT SAVED: %s. Sanitized delta queued at %s; coverage is not advanced." % (exc, queued))
    finally:
        store.release()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    ini = sub.add_parser("init")
    ini.add_argument("--confirmed", action="store_true")
    sub.add_parser("read")
    sub.add_parser("flush")
    sv = sub.add_parser("save")
    sv.add_argument("--delta", required=True)
    sv.add_argument("--mode", default="interactive", choices=["interactive", "headless"])
    a = ap.parse_args(argv)

    cfg = load_config()
    if cfg["persistence"].get("backend") != "gitlab-snippet":
        die("persistence.backend must be 'gitlab-snippet' (see references/config.md)")
    try:
        store = GitLabSnippetStore(cfg)
        if a.cmd == "status":
            info = store.lookup()
            emit({"found": info is not None, "id": info and info["id"], "visibility": info and info["visibility"],
                  "url": info and info.get("web_url"), "updated_at": info and info.get("updated_at"),
                  "outbox": len(pending())})
        elif a.cmd == "init":
            if not a.confirmed:
                die("init needs --confirmed, after the user explicitly approves creating the private snippet")
            if store.lookup() is not None:
                die("a record already exists; nothing to initialize")
            created = store.create()
            emit({"result": "CREATED", "id": created["id"], "url": created.get("web_url"),
                  "visibility": created["visibility"]})
        elif a.cmd == "read":
            record, _ = store.read()
            sys.stdout.write(dump_record(record))
        elif a.cmd == "save":
            delta = checked_delta(a.delta, a.mode, cfg)
            emit(save_with_outbox(store, delta, a.mode))
        else:
            done, results = 0, []
            for path in pending():
                item = json.loads(path.read_text())
                if privacy_violations(item["delta"], cfg) or validate_delta(item["delta"], item["mode"]):
                    die("queued delta %s no longer passes checks; leaving it in the outbox" % path.name)
                results.append(save_with_outbox_noqueue(store, item))
                path.unlink()
                done += 1
            emit({"flushed": done, "results": results})
    except PersistError as exc:
        die(str(exc))
    return 0


def save_with_outbox_noqueue(store, item):
    store.acquire()
    try:
        return store.save(item["delta"], item["mode"])
    finally:
        store.release()


if __name__ == "__main__":
    sys.exit(main())
