import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"


def run_script(name, args, env_extra, cwd=None):
    env = dict(os.environ)
    env.update(env_extra)
    return subprocess.run([sys.executable, str(SCRIPTS / name)] + args, capture_output=True,
                          text=True, env=env, cwd=cwd)


def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.claude, self.codex = t / "claude", t / "codex"
        cfg_dir, state = t / "cfg", t / "state"
        cfg_dir.mkdir()
        (cfg_dir / "config.json").write_text(json.dumps({"sources": {
            "opencode": {"command": "%s %s" % (sys.executable, HERE / "fake_opencode.py")},
            "claude": {"root": str(self.claude)}, "codex": {"root": str(self.codex)}}}))
        self.env = {"WORKFLOW_RETROSPECTIVE_CONFIG_DIR": str(cfg_dir),
                    "WORKFLOW_RETROSPECTIVE_STATE_DIR": str(state)}
        self.claude_file = self.claude / "proj" / "abc.jsonl"
        write_jsonl(self.claude_file, [
            {"type": "ai-title", "aiTitle": "Claude session"},
            {"type": "user", "timestamp": "2023-11-14T22:20:00Z", "cwd": "/work/c",
             "message": {"role": "user", "content": "do the thing"}},
            {"type": "assistant", "timestamp": "2023-11-14T22:20:05Z", "message": {"role": "assistant", "content": [
                {"type": "thinking", "thinking": ""}, {"type": "text", "text": "On it."},
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}},
            {"type": "user", "timestamp": "2023-11-14T22:20:06Z", "message": {"role": "user", "content": [
                {"type": "tool_result", "content": "file list", "is_error": True}]}},
            {"type": "user", "timestamp": "2023-11-14T22:20:07Z", "isMeta": True,
             "message": {"role": "user", "content": "meta noise"}},
            {"type": "assistant", "timestamp": "2023-11-14T22:20:08Z", "isSidechain": True,
             "message": {"role": "assistant", "content": [{"type": "text", "text": "subagent chatter"}]}},
            {"type": "user", "timestamp": "2023-11-14T22:25:00Z",
             "message": {"role": "user", "content": "no, don't over do it"}},
        ])
        self.codex_file = self.codex / "2023" / "11" / "14" / "rollout-a.jsonl"
        write_jsonl(self.codex_file, [
            {"timestamp": "2023-11-14T22:30:00Z", "type": "session_meta",
             "payload": {"id": "cdx-1", "cwd": "/work/x", "source": "cli"}},
            {"timestamp": "2023-11-14T22:30:01Z", "type": "event_msg",
             "payload": {"type": "user_message", "message": "fix it"}},
            {"timestamp": "2023-11-14T22:30:02Z", "type": "response_item",
             "payload": {"type": "function_call", "name": "exec_command", "call_id": "c1", "arguments": "{\"cmd\":\"make\"}"}},
            {"timestamp": "2023-11-14T22:30:03Z", "type": "response_item",
             "payload": {"type": "function_call_output", "call_id": "c1", "output": "Process exited with code 2\n"}},
            {"timestamp": "2023-11-14T22:30:04Z", "type": "event_msg",
             "payload": {"type": "agent_message", "message": "failed"}},
            {"timestamp": "2023-11-14T22:30:05Z", "type": "event_msg",
             "payload": {"type": "turn_aborted", "reason": "interrupted"}},
        ])
        write_jsonl(self.codex / "2023" / "11" / "14" / "rollout-child.jsonl", [
            {"timestamp": "2023-11-14T22:31:00Z", "type": "session_meta",
             "payload": {"id": "cdx-2", "cwd": "/work/x", "source": {"subagent": {"parent_thread_id": "cdx-1"}}}},
            {"timestamp": "2023-11-14T22:31:01Z", "type": "event_msg", "payload": {"type": "user_message", "message": "x"}},
        ])

    def tearDown(self):
        self.tmp.cleanup()

    def inventory(self, *extra):
        proc = run_script("collect.py", ["inventory", "--since", "2023-01-01T00:00:00Z",
                                         "--until", "2024-01-01T00:00:00Z"] + list(extra), self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def read(self, source, ref, *extra):
        proc = run_script("collect.py", ["read", "--source", source, "--ref", ref] + list(extra), self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_inventory_covers_all_sources_and_separates_children(self):
        inv = self.inventory()
        by_source = {}
        for s in inv["sessions"]:
            by_source.setdefault(s["source"], []).append(s)
        self.assertEqual(sorted(by_source), ["claude", "codex", "opencode"])
        self.assertEqual([s["ref"] for s in by_source["opencode"]], ["ses_new"])
        self.assertEqual(inv["sources"]["opencode"]["children"], 1)
        self.assertEqual(inv["sources"]["codex"]["children"], 1)
        self.assertEqual(by_source["claude"][0]["title"], "Claude session")
        for s in inv["sessions"]:
            self.assertRegex(s["sid"], r"^[0-9a-f]{16}$")

    def test_since_excludes_older_opencode_sessions(self):
        proc = run_script("collect.py", ["inventory", "--source", "opencode", "--since", "2020-01-01T00:00:00Z",
                                         "--until", "2024-01-01T00:00:00Z"], self.env)
        refs = [s["ref"] for s in json.loads(proc.stdout)["sessions"]]
        self.assertEqual(refs, ["ses_new", "ses_old"])

    def test_sids_are_stable_and_machine_scoped(self):
        first, second = self.inventory(), self.inventory()
        self.assertEqual([s["sid"] for s in first["sessions"]], [s["sid"] for s in second["sessions"]])
        self.assertRegex(first["machine"], r"^m-[0-9a-f]{12}$")

    def test_unavailable_source_is_reported_not_fatal(self):
        cfg = Path(self.env["WORKFLOW_RETROSPECTIVE_CONFIG_DIR"]) / "config.json"
        data = json.loads(cfg.read_text())
        data["sources"]["opencode"]["command"] = "definitely-not-a-command-xyz"
        cfg.write_text(json.dumps(data))
        inv = self.inventory()
        self.assertEqual(inv["sources"]["opencode"]["status"], "error")
        self.assertEqual(inv["sources"]["claude"]["status"], "ok")

    def test_claude_read_filters_meta_and_sidechains(self):
        out = self.read("claude", str(self.claude_file))
        roles = [t["role"] for t in out["turns"]]
        self.assertEqual(roles, ["user", "assistant", "tool", "tool_result", "user"])
        self.assertTrue(out["turns"][3]["error"])
        self.assertNotIn("subagent chatter", json.dumps(out))
        side = self.read("claude", str(self.claude_file), "--include-sidechains")
        self.assertIn("subagent chatter", json.dumps(side))

    def test_codex_read_captures_exit_code_and_interrupt(self):
        out = self.read("codex", str(self.codex_file))
        tool = next(t for t in out["turns"] if t["role"] == "tool")
        self.assertEqual(tool["exit_code"], 2)
        self.assertEqual(out["turns"][-1]["kind"], "interrupted")

    def test_opencode_read_drops_reasoning_and_skill_bodies(self):
        out = self.read("opencode", "ses_new")
        text = json.dumps(out)
        self.assertNotIn("HUGE BODY", text)
        self.assertEqual([t["role"] for t in out["turns"]], ["user", "assistant", "assistant", "tool", "user"])
        self.assertLess(len(text), 20000)
        self.assertEqual(out["turns"][-1]["skills"], ["plan-ticket"])

    def test_after_keeps_leading_context_and_flags_it(self):
        out = self.read("claude", str(self.claude_file), "--after", "2023-11-14T22:24:00Z", "--context-turns", "1")
        self.assertEqual(out["turns_before_window"], 3)
        self.assertTrue(out["turns"][0].get("context"))
        self.assertEqual(out["turns"][1]["text"], "no, don't over do it")

    def test_session_budget_never_drops_user_turns(self):
        cfg = Path(self.env["WORKFLOW_RETROSPECTIVE_CONFIG_DIR"]) / "config.json"
        data = json.loads(cfg.read_text())
        data["limits"] = {"max_chars_per_session": 200}
        cfg.write_text(json.dumps(data))
        out = self.read("claude", str(self.claude_file))
        self.assertTrue(out["truncated"])
        self.assertEqual([t["text"] for t in out["turns"] if t["role"] == "user"],
                         ["do the thing", "no, don't over do it"])


if __name__ == "__main__":
    unittest.main()
