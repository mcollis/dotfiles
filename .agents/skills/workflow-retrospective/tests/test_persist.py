import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import persist as P  # noqa: E402
import record as R  # noqa: E402
from wr_common import load_config  # noqa: E402

S1, S2, S3 = "a" * 16, "b" * 16, "c" * 16
GIT = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"]


def git(*args, cwd=None):
    out = subprocess.run(GIT + list(args), capture_output=True, text=True, cwd=cwd)
    assert out.returncode == 0, out.stderr
    return out.stdout


def finding(key, sid, at="2026-10-01T10:00:00Z"):
    return {"key": key, "title": "T " + key, "summary": "Generalized summary of friction.",
            "class": "manual_effort", "category": "manual_workflow",
            "evidence": [{"sid": sid, "note": "user repeated the same manual step", "at": at}]}


class FakeRun:
    """Routes `glab` to canned responses and everything else to the real command."""

    def __init__(self, remote, visibility="private", extra_rows=None, fail_glab=False):
        self.remote, self.visibility, self.fail_glab = remote, visibility, fail_glab
        self.extra_rows = extra_rows or []
        self.glab_calls = []

    def __call__(self, cmd, env=None, input_text=None, cwd=None):
        if cmd[0] != "glab":
            return subprocess.run(cmd, capture_output=True, text=True, env=env, input=input_text, cwd=cwd)
        self.glab_calls.append((cmd, dict(env or {})))
        if self.fail_glab:
            return subprocess.CompletedProcess(cmd, 1, "", "boom")
        if "POST" in cmd:
            with open(cmd[cmd.index("--input") + 1]) as handle:
                body = json.load(handle)
            created = {"id": 7, "visibility": self.visibility, "web_url": "https://x/7", "payload": body}
            return subprocess.CompletedProcess(cmd, 0, json.dumps(created), "")
        rows = [{"id": 7, "title": "Workflow-Retrospective ", "visibility": self.visibility,
                 "ssh_url_to_repo": self.remote, "web_url": "https://x/7", "updated_at": "t"}] + self.extra_rows
        half = max(1, len(rows) // 2)
        return subprocess.CompletedProcess(cmd, 0, json.dumps(rows[:half]) + json.dumps(rows[half:]), "")


class PersistTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        os.environ["WORKFLOW_RETROSPECTIVE_STATE_DIR"] = str(t / "state")
        self.addCleanup(os.environ.pop, "WORKFLOW_RETROSPECTIVE_STATE_DIR", None)
        self.remote = str(t / "remote.git")
        git("init", "--bare", "-b", "main", self.remote)
        seed = t / "seed"
        git("init", "-b", "main", str(seed))
        (seed / P.FILE_JSON).write_text(P.dump_record(R.new_record()))
        (seed / P.FILE_MD).write_text(R.render(R.new_record()))
        git("add", ".", cwd=str(seed))
        git("commit", "-m", "init", cwd=str(seed))
        git("remote", "add", "origin", self.remote, cwd=str(seed))
        git("push", "origin", "main", cwd=str(seed))
        self.cfg = load_config()
        self.cfg["persistence"] = {"backend": "gitlab-snippet", "host": "gitlab.example.invalid"}

    def tearDown(self):
        self.tmp.cleanup()

    def store(self, run=None, **kw):
        return P.GitLabSnippetStore(self.cfg, run=run or FakeRun(self.remote), **kw)

    def remote_record(self):
        out = git("--git-dir", self.remote, "show", "main:" + P.FILE_JSON)
        return json.loads(out)

    def competing_writer(self, key, sid):
        def hook(attempt):
            other = Path(self.tmp.name) / ("other%d" % attempt)
            git("clone", "-q", self.remote, str(other))
            rec = json.loads((other / P.FILE_JSON).read_text())
            rec, _ = R.merge(rec, {"findings": [finding(key + str(attempt), sid)]}, "headless")
            (other / P.FILE_JSON).write_text(P.dump_record(rec))
            git("commit", "-qam", "other writer", cwd=str(other))
            git("push", "-q", "origin", "HEAD", cwd=str(other))
        return hook

    # -- lookup ------------------------------------------------------------

    def test_lookup_matches_title_case_and_whitespace_insensitively_across_pages(self):
        self.assertEqual(self.store().lookup()["id"], 7)

    def test_non_private_snippet_is_refused(self):
        with self.assertRaisesRegex(P.PersistError, "not private"):
            self.store(FakeRun(self.remote, visibility="internal")).lookup()

    def test_duplicate_titles_fail_closed(self):
        dup = {"id": 8, "title": "workflow-retrospective", "visibility": "private"}
        with self.assertRaisesRegex(P.PersistError, "resolve the duplicate"):
            self.store(FakeRun(self.remote, extra_rows=[dup])).lookup()

    def test_failed_lookup_is_unknown_not_absent(self):
        with self.assertRaises(P.PersistError):
            self.store(FakeRun(self.remote, fail_glab=True)).lookup()

    # -- save ----------------------------------------------------------------

    def test_save_merges_pushes_and_renders_both_files(self):
        out = self.store().save({"findings": [finding("alpha-step", S1)]}, "headless")
        self.assertEqual((out["result"], out["revision"], out["attempts"]), ("SAVED", 1, 1))
        self.assertEqual(self.remote_record()["findings"][0]["id"], "f-alpha-step")
        self.assertIn("T alpha-step", git("--git-dir", self.remote, "show", "main:" + P.FILE_MD))

    def test_competing_update_is_remerged_not_overwritten(self):
        store = self.store(before_push=lambda n: self.competing_writer("other-find", S2)(n) if n == 0 else None)
        out = store.save({"findings": [finding("mine-find", S1)]}, "interactive")
        self.assertEqual(out["attempts"], 2)
        ids = sorted(f["id"] for f in self.remote_record()["findings"])
        self.assertEqual(ids, ["f-mine-find", "f-other-find0"])
        self.assertEqual(self.remote_record()["revision"], 2)

    def test_exhausted_conflicts_stop_without_overwriting_remote(self):
        store = self.store(before_push=self.competing_writer("other-find", S2))
        with self.assertRaisesRegex(P.PersistError, "conflicted 3 times"):
            store.save({"findings": [finding("mine-find", S1)]}, "interactive")
        ids = {f["id"] for f in self.remote_record()["findings"]}
        self.assertNotIn("f-mine-find", ids)
        self.assertEqual(len(ids), 3)

    def test_invalid_stored_record_requires_reconciliation(self):
        other = Path(self.tmp.name) / "corrupt"
        git("clone", "-q", self.remote, str(other))
        (other / P.FILE_JSON).write_text(json.dumps({"schema": 99}))
        git("commit", "-qam", "bad", cwd=str(other))
        git("push", "-q", "origin", "HEAD", cwd=str(other))
        with self.assertRaisesRegex(P.PersistError, "unsupported"):
            self.store().save({"findings": [finding("alpha-step", S1)]}, "headless")

    def test_oversized_record_is_refused_not_truncated(self):
        self.cfg["limits"]["max_record_bytes"] = 100
        with self.assertRaisesRegex(P.PersistError, "would exceed"):
            self.store().save({"findings": [finding("alpha-step", S1)]}, "headless")

    # -- outbox ----------------------------------------------------------------

    def test_failed_save_queues_only_the_sanitized_delta_and_flush_recovers(self):
        delta = {"findings": [finding("alpha-step", S1)]}
        down = self.store(FakeRun(self.remote, fail_glab=True))
        with self.assertRaisesRegex(P.PersistError, "NOT SAVED"):
            P.save_with_outbox(down, delta, "headless")
        self.assertEqual(len(P.pending()), 1)
        item = json.loads(P.pending()[0].read_text())
        self.assertEqual(item["delta"], delta)
        up = self.store()
        item = json.loads(P.pending()[0].read_text())
        P.save_with_outbox_noqueue(up, item)
        P.pending()[0].unlink()
        self.assertEqual(self.remote_record()["findings"][0]["id"], "f-alpha-step")

    def test_unsafe_delta_is_rejected_before_any_queueing(self):
        bad = Path(self.tmp.name) / "bad.json"
        bad.write_text(json.dumps({"findings": [dict(finding("alpha-step", S1), summary="see https://x.example.com/y")]}))
        with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()) as out:
            P.checked_delta(str(bad), "headless", self.cfg)
        self.assertNotIn("example.com", out.getvalue())
        self.assertEqual(P.pending(), [])

    # -- create ----------------------------------------------------------------

    def test_create_is_private_and_only_create_drops_read_only_token(self):
        os.environ["GITLAB_TOKEN"] = "readonly-token-value"
        self.addCleanup(os.environ.pop, "GITLAB_TOKEN", None)
        run = FakeRun(self.remote)
        created = self.store(run).create()
        self.assertEqual(created["visibility"], "private")
        self.assertEqual(created["payload"]["visibility"], "private")
        self.assertEqual(sorted(f["file_path"] for f in created["payload"]["files"]), [P.FILE_JSON, P.FILE_MD])
        self.store(run).lookup()
        write_env, read_env = run.glab_calls[0][1], run.glab_calls[1][1]
        self.assertNotIn("GITLAB_TOKEN", write_env)
        self.assertEqual(read_env.get("GITLAB_TOKEN"), "readonly-token-value")

    def test_create_refuses_a_non_private_result(self):
        with self.assertRaisesRegex(P.PersistError, "not private"):
            self.store(FakeRun(self.remote, visibility="internal")).create()

    def test_missing_host_is_a_configuration_error(self):
        self.cfg["persistence"] = {"backend": "gitlab-snippet"}
        with self.assertRaisesRegex(P.PersistError, "persistence.host"):
            P.GitLabSnippetStore(self.cfg)


if __name__ == "__main__":
    unittest.main()
