import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import environment as E  # noqa: E402
from wr_common import load_config  # noqa: E402


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = Path(self.tmp.name)
        self.saved = {k: os.environ.get(k) for k in ("HOME", "WORKFLOW_RETROSPECTIVE_CONFIG_DIR", "WORKFLOW_RETROSPECTIVE_STATE_DIR")}
        os.environ["HOME"] = str(home)
        os.environ["WORKFLOW_RETROSPECTIVE_CONFIG_DIR"] = str(home / "cfg")
        os.environ["WORKFLOW_RETROSPECTIVE_STATE_DIR"] = str(home / "state")
        (home / ".agents" / "skills" / "demo").mkdir(parents=True)
        (home / ".agents" / "AGENTS.md##template").write_text("template")
        (home / ".agents" / "AGENTS.md").write_text("rendered")
        (home / ".claude").mkdir()
        (home / ".claude" / "CLAUDE.md").symlink_to("../.agents/AGENTS.md")
        self.skill = home / ".agents" / "skills" / "demo" / "SKILL.md"
        self.skill.write_text("---\nname: demo\ndescription: Does a demo thing\n---\nbody\n")

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_instruction_files_report_canonical_source_and_generated_siblings(self):
        facts = {f["id"]: f for f in E.discover(load_config())}
        agents = facts["instructions:~/.agents/AGENTS.md"]["value"]
        self.assertTrue(agents["generated_from"][0].endswith("AGENTS.md##template"))
        link = facts["instructions:~/.claude/CLAUDE.md"]["value"]
        self.assertTrue(link["is_symlink"])
        self.assertTrue(link["canonical"].endswith(".agents/AGENTS.md"))

    def test_skill_inventory_has_content_hash_and_description(self):
        skills = E.inventory_skills(load_config())
        self.assertEqual([s["id"] for s in skills], ["demo"])
        before = skills[0]["hash"]
        self.skill.write_text(self.skill.read_text() + "more\n")
        self.assertNotEqual(E.inventory_skills(load_config())[0]["hash"], before)
        self.assertEqual(skills[0]["description"], "Does a demo thing")

    def test_staleness_is_by_change_not_age(self):
        doc = {"facts": E.discover(load_config())}
        self.assertEqual(E.check(doc), [])
        time.sleep(0.01)
        (Path(self.tmp.name) / ".agents" / "AGENTS.md").write_text("rendered and changed")
        self.assertEqual(sorted(E.check(doc)),
                         ["instructions:~/.agents/AGENTS.md", "instructions:~/.claude/CLAUDE.md"])

    def test_no_credentials_in_discovered_facts(self):
        os.environ["GITLAB_TOKEN"] = "super-secret-value"
        self.addCleanup(os.environ.pop, "GITLAB_TOKEN", None)
        self.assertNotIn("super-secret-value", json.dumps(E.discover(load_config())))


if __name__ == "__main__":
    unittest.main()
