import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import record as R  # noqa: E402
from wr_common import load_config, to_ms  # noqa: E402

S1, S2, S3 = "a" * 16, "b" * 16, "c" * 16
DAY = 86400 * 1000


def finding(key="skipped-setup-hooks", sid=S1, at="2026-10-01T10:00:00Z", **over):
    base = {
        "key": key, "title": "Setup steps skipped on request", "summary": "A configured setup step was skipped without being asked.",
        "class": "high_impact", "category": "invented_constraint", "impact": "high", "confidence": "medium",
        "proposal": "Run configured setup unless told otherwise.",
        "evidence": [{"sid": sid, "note": "agent skipped setup and justified it with a constraint nobody stated", "at": at}],
    }
    base.update(over)
    return base


def merged(rec, delta, mode="interactive", now="2026-10-02T00:00:00Z"):
    return R.merge(rec, delta, mode, now)


class MergeTests(unittest.TestCase):
    def test_new_finding_then_idempotent_remerge(self):
        rec, rep = merged(R.new_record(), {"findings": [finding()]})
        self.assertEqual(rep["findings_added"], ["f-skipped-setup-hooks"])
        again, _ = merged(rec, {"findings": [finding()]})
        self.assertEqual(again["findings"][0]["recurrence"], 1)
        self.assertEqual(len(again["findings"][0]["evidence"]), 1)

    def test_distinct_sessions_increase_recurrence(self):
        rec, _ = merged(R.new_record(), {"findings": [finding()]})
        rec, _ = merged(rec, {"findings": [finding(sid=S2, at="2026-10-05T10:00:00Z")]})
        f = rec["findings"][0]
        self.assertEqual(f["recurrence"], 2)
        self.assertEqual(f["last_seen"], "2026-10-05T10:00:00Z")

    def test_unselected_findings_survive_other_updates(self):
        rec, _ = merged(R.new_record(), {"findings": [finding(), finding(key="over-engineered-fix", sid=S2)]})
        rec, _ = merged(rec, {"findings": [finding(sid=S3)]})
        self.assertEqual(sorted(f["id"] for f in rec["findings"]),
                         ["f-over-engineered-fix", "f-skipped-setup-hooks"])

    def test_headless_cannot_decide_or_confirm(self):
        with self.assertRaises(ValueError):
            merged(R.new_record(), {"decisions": [{"id": "f-x-y-z", "state": "dismissed"}]}, "headless")
        with self.assertRaises(ValueError):
            merged(R.new_record(), {"profile": [{"id": "plan-first", "text": "t", "scope": "s", "status": "confirmed"}]}, "headless")

    def test_decision_changes_state_and_freezes_descriptive_fields(self):
        rec, _ = merged(R.new_record(), {"findings": [finding()]})
        rec, rep = merged(rec, {"decisions": [{"id": "f-skipped-setup-hooks", "state": "planned", "note": "agreed"}]})
        self.assertEqual(rep["decisions_applied"], ["f-skipped-setup-hooks"])
        rec, rep = merged(rec, {"findings": [finding(proposal="Something different", sid=S2)]}, "headless")
        self.assertEqual(rec["findings"][0]["proposal"], "Run configured setup unless told otherwise.")
        self.assertEqual(rep["findings_ignored_fields"][0]["fields"], ["proposal"])

    def test_recurrence_after_resolution_is_surfaced_not_reopened(self):
        rec, _ = merged(R.new_record(), {"findings": [finding()]})
        rec, _ = merged(rec, {"decisions": [{"id": "f-skipped-setup-hooks", "state": "implemented"}]},
                        now="2026-10-10T00:00:00Z")
        rec, rep = merged(rec, {"findings": [finding(sid=S2, at="2026-10-20T00:00:00Z")]}, "headless",
                          now="2026-10-21T00:00:00Z")
        f = rec["findings"][0]
        self.assertEqual(f["state"], "implemented")
        self.assertEqual(rep["recurred"], ["f-skipped-setup-hooks"])
        self.assertEqual(f["recurred_after_resolution"], 1)
        rec, rep = merged(rec, {"findings": [finding(sid=S3, at="2026-09-01T00:00:00Z")]}, "headless")
        self.assertEqual(rep["recurred"], [])
        self.assertEqual(rec["findings"][0]["recurrence"], 3)

    def test_tentative_never_overrides_confirmed_but_records_contradiction(self):
        pref = {"id": "plan-before-build", "text": "Plan decides, Build executes", "scope": "implementation", "status": "confirmed"}
        rec, _ = merged(R.new_record(), {"profile": [pref]})
        rec, rep = merged(rec, {"profile": [dict(pref, status="tentative", text="Build may decide small things")]}, "headless")
        entry = rec["profile"]["entries"][0]
        self.assertEqual(entry["text"], "Plan decides, Build executes")
        self.assertEqual(entry["status"], "confirmed")
        self.assertEqual(rep["profile_contradictions"], ["plan-before-build"])
        rec, _ = merged(rec, {"profile": [dict(pref, text="Plan decides; Build executes faithfully")]})
        self.assertEqual(rec["profile"]["entries"][0]["contradictions"], [])

    def test_withheld_and_review_are_recorded(self):
        rec, _ = merged(R.new_record(), {"withheld": [{"class": "business_detail"}],
                                         "review": {"id": "r-one", "kind": "general", "summary": "first pass"}})
        self.assertEqual(rec["withheld"], {"count": 1, "classes": {"business_detail": 1}})
        self.assertEqual(rec["reviews"][0]["id"], "r-one")

    def test_unknown_schema_requires_reconciliation(self):
        bad = R.new_record()
        bad["schema"] = 99
        with self.assertRaises(ValueError):
            merged(bad, {})

    def test_invalid_enums_are_rejected(self):
        with self.assertRaises(ValueError):
            merged(R.new_record(), {"findings": [finding(**{"class": "whatever"})]})


class PrivacyTests(unittest.TestCase):
    def hits(self, text, cfg=None):
        return {h["rule"] for h in R.privacy_violations({"findings": [{"summary": text}]}, cfg or load_config())}

    def test_rejects_identifying_content(self):
        cases = {
            "see https://git.example.com/x": "url",
            "ask someone@example.com": "email",
            "ticket ABC-1234 was slow": "ticket_key",
            "in MR !12345": "review_ref",
            "edited /Users/someone/work/file": "absolute_path",
            "edited src/components/Panel": "relative_path",
            "changed Panel.tsx": "filename",
            "host build.internal.example.com failed": "hostname",
            "commit 3fa9c0d1e2": "commit_hash",
            "key AKIAABCDEFGHIJKLMNOP leaked": "secret",
            "```code```": "code_fence",
            'said "this is a long raw quotation that should never be stored verbatim"': "long_quotation",
            "called `useSomething(arg)` wrongly": "inline_code",
        }
        for text, rule in cases.items():
            self.assertIn(rule, self.hits(text), text)

    def test_accepts_generalized_lessons(self):
        for text in ("The agent skipped a configured setup step and invented a reason",
                     "Plan/Build handoff lacked reuse guidance; see `plan-ticket` and SKILL.md",
                     "User asked for slimmer test coverage twice in one planning session"):
            self.assertEqual(self.hits(text), set(), text)

    def test_config_deny_terms_and_patterns(self):
        cfg = load_config()
        cfg["privacy"] = {"deny_terms": ["Acme"], "deny_patterns": [r"project-\w+"]}
        self.assertIn("denied_term", self.hits("Acme platform behaved oddly", cfg))
        self.assertIn("denied_pattern", self.hits("worked on project-falcon", cfg))

    def test_sid_and_machine_fields_are_exempt_but_idents_are_checked(self):
        delta = {"findings": [{"key": "abc-1234", "evidence": [{"sid": "3fa9c0d1e2b4a5f6", "note": "ok", "at": "2026-01-01T00:00:00Z"}]}]}
        rules = [h["rule"] for h in R.privacy_violations(delta, load_config())]
        self.assertEqual(rules, ["ticket_key"])

    def test_violations_never_echo_matched_text(self):
        out = json.dumps(R.privacy_violations({"summary": "see https://secret.example.com"}, load_config()))
        self.assertNotIn("secret.example.com", out)


def entry(source="opencode", machine="m-1", kind="general", focus=None, frm=0, to=10 * DAY, complete=True, sessions=None):
    scope = {"kind": kind}
    if focus:
        scope["focus"] = focus
    return {"source": source, "machine": machine, "scope": scope, "from_ms": frm, "to_ms": to,
            "complete": complete, "sessions": sessions or {}, "gaps": []}


def with_coverage(*entries):
    rec = R.new_record()
    rec["coverage"] = list(entries)
    return rec


class CoverageTests(unittest.TestCase):
    NOW = 100 * DAY

    def window(self, rec, scope, since=None, source="opencode"):
        return R.window(rec, scope, [source], "m-1", self.NOW, 30, since)["per_source"][source]

    def test_default_is_thirty_days_without_coverage(self):
        w = self.window(R.new_record(), {"kind": "general"})
        self.assertEqual((w["basis"], w["since_ms"]), ("default", self.NOW - 30 * DAY))

    def test_since_previous_complete_review(self):
        w = self.window(with_coverage(entry(to=90 * DAY, frm=60 * DAY)), {"kind": "general"})
        self.assertEqual((w["basis"], w["since_ms"]), ("coverage", 90 * DAY))

    def test_focused_review_never_advances_general_window(self):
        rec = with_coverage(entry(kind="focus", focus="planning", frm=60 * DAY, to=95 * DAY))
        self.assertEqual(self.window(rec, {"kind": "general"})["basis"], "default")

    def test_general_coverage_applies_to_focus_but_other_focus_does_not(self):
        rec = with_coverage(entry(frm=60 * DAY, to=90 * DAY), entry(kind="focus", focus="other", frm=60 * DAY, to=99 * DAY))
        self.assertEqual(self.window(rec, {"kind": "focus", "focus": "planning"})["since_ms"], 90 * DAY)

    def test_coverage_is_per_source_and_machine(self):
        rec = with_coverage(entry(source="claude", to=90 * DAY, frm=60 * DAY), entry(machine="m-2", to=95 * DAY, frm=60 * DAY))
        self.assertEqual(self.window(rec, {"kind": "general"})["basis"], "default")

    def test_noncontiguous_review_leaves_a_hole_and_does_not_advance(self):
        rec = with_coverage(entry(frm=60 * DAY, to=70 * DAY), entry(frm=80 * DAY, to=95 * DAY))
        w = self.window(rec, {"kind": "general"})
        self.assertEqual(w["since_ms"], 70 * DAY)
        self.assertEqual(w["holes"], [{"from_ms": 70 * DAY, "to_ms": 80 * DAY}])

    def inventory(self, *sessions, status="ok"):
        return {"window": {"until_ms": self.NOW}, "sources": {"opencode": {"status": status}},
                "sessions": list(sessions), "children": []}

    def sess(self, sid, created, updated):
        return {"source": "opencode", "ref": "r-" + sid, "sid": sid, "created_ms": created, "updated_ms": updated}

    def test_plan_flags_old_sessions_with_new_activity(self):
        rec = with_coverage(entry(frm=60 * DAY, to=90 * DAY))
        inv = self.inventory(self.sess(S1, 10 * DAY, 95 * DAY), self.sess(S2, 92 * DAY, 96 * DAY), self.sess(S3, 1 * DAY, 2 * DAY))
        p = R.plan(rec, {"kind": "general"}, inv, "m-1", 30)["per_source"]["opencode"]
        got = {e["sid"]: (e["reason"], e["after_ms"]) for e in p["examine"]}
        self.assertEqual(got, {S1: ("new_activity", 90 * DAY), S2: ("new", None)})

    def test_partial_review_is_resumed_without_repeating_work(self):
        done = entry(frm=70 * DAY, to=self.NOW, complete=False, sessions={S1: 95 * DAY})
        inv = self.inventory(self.sess(S1, 80 * DAY, 95 * DAY), self.sess(S2, 85 * DAY, 96 * DAY), self.sess(S3, 86 * DAY, 97 * DAY))
        inv["sessions"][2]["updated_ms"] = 98 * DAY
        rec = with_coverage(done)
        p = R.plan(rec, {"kind": "general"}, inv, "m-1", 30)["per_source"]["opencode"]
        self.assertEqual(p["skipped_already_reviewed"], 1)
        self.assertEqual(sorted(e["sid"] for e in p["examine"]), [S2, S3])
        inv["sessions"][0]["updated_ms"] = 99 * DAY
        p = R.plan(rec, {"kind": "general"}, inv, "m-1", 30)["per_source"]["opencode"]
        resumed = {e["sid"]: e["after_ms"] for e in p["examine"]}
        self.assertEqual(resumed[S1], 95 * DAY)

    def test_unfinished_or_unavailable_review_is_never_complete(self):
        inv = self.inventory(self.sess(S1, 80 * DAY, 95 * DAY), self.sess(S2, 85 * DAY, 96 * DAY))
        plan = R.plan(R.new_record(), {"kind": "general"}, inv, "m-1", 30)
        partial = R.coverage_entry(plan, "opencode", [S1], [])
        self.assertFalse(partial["complete"])
        self.assertEqual(partial["sessions"], {S1: 95 * DAY})
        full = R.coverage_entry(plan, "opencode", [S1, S2], [])
        self.assertTrue(full["complete"])
        down = R.plan(R.new_record(), {"kind": "general"}, self.inventory(status="error"), "m-1", 30)
        self.assertFalse(R.coverage_entry(down, "opencode", [], [])["complete"])

    def test_complete_review_compacts_superseded_partials(self):
        rec = with_coverage(entry(frm=70 * DAY, to=95 * DAY, complete=False, sessions={S1: 90 * DAY}))
        rec, _ = R.merge(rec, {"coverage": [entry(frm=70 * DAY, to=99 * DAY)]}, "headless", "2026-10-02T00:00:00Z")
        self.assertEqual(rec["coverage"][0]["sessions"], {})
        self.assertTrue(rec["coverage"][0]["compacted"])


class RenderTests(unittest.TestCase):
    def test_priority_order_follows_class_then_impact(self):
        rec, _ = merged(R.new_record(), {"findings": [
            finding(key="opportunity-one", title="Opp", **{"class": "opportunity", "impact": "high"}),
            finding(key="high-impact-one", title="HighImp", sid=S2),
            finding(key="manual-effort-one", title="Manual", sid=S3, **{"class": "manual_effort"}),
            finding(key="repeat-correction", title="Repeat", **{"class": "repeated_correction", "impact": "low"}),
        ]})
        text = R.render(rec, limit=2)
        positions = [text.index(t) for t in ("**Repeat**", "**Manual**", "## Remaining backlog", "**HighImp**", "**Opp**")]
        self.assertEqual(positions, sorted(positions))

    def test_recurred_resolved_finding_leads_the_overview(self):
        rec, _ = merged(R.new_record(), {"findings": [
            finding(title="Resolved one"),
            finding(key="another-thing", title="Other", sid=S2, **{"class": "repeated_correction"})]})
        rec, _ = merged(rec, {"decisions": [{"id": "f-skipped-setup-hooks", "state": "validated"}]}, now="2026-10-03T00:00:00Z")
        rec, _ = merged(rec, {"findings": [finding(sid=S3, at="2026-10-20T00:00:00Z")]}, "headless", now="2026-10-21T00:00:00Z")
        text = R.render(rec)
        self.assertLess(text.index("RECURRED after validated"), text.index("**Other**"))

    def test_render_is_deterministic_and_lists_tentative_profile(self):
        pref = {"id": "short-answers", "text": "Prefers concise answers", "scope": "global", "status": "tentative"}
        rec, _ = merged(R.new_record(), {"profile": [pref], "findings": [finding()]})
        self.assertEqual(R.render(rec), R.render(copy.deepcopy(rec)))
        self.assertIn("[tentative] (global) Prefers concise answers", R.render(rec))


FID = "f-skipped-setup-hooks"


def assess(fid=FID, status="implemented", note="Guidance is now in place.", **over):
    a = {"id": fid, "status": status, "note": note, "at": "2026-10-10T00:00:00Z"}
    a.update(over)
    return a


class AssessmentTests(unittest.TestCase):
    def base(self, **over):
        rec, _ = merged(R.new_record(), {"findings": [finding(**over)]})
        return rec

    def test_allowed_headless_and_never_touches_state_or_decisions(self):
        rec = self.base()
        rec, _ = merged(rec, {"decisions": [{"id": FID, "state": "planned", "note": "agreed"}]})
        rec, rep = merged(rec, {"assessments": [assess()]}, "headless")
        f = rec["findings"][0]
        self.assertEqual(rep["assessments_applied"], [FID])
        self.assertEqual((f["state"], len(f["decisions"])), ("planned", 1))
        self.assertEqual(f["assessment"]["status"], "implemented")

    def test_rejects_unknown_finding_bad_status_and_misplaced_evidence(self):
        rec = self.base()
        with self.assertRaises(ValueError):
            merged(rec, {"assessments": [assess(fid="f-does-not-exist")]})
        with self.assertRaises(ValueError):
            merged(rec, {"assessments": [assess(status="fixed")]})
        with self.assertRaises(ValueError):
            merged(rec, {"assessments": [assess(note="")]})
        ev = [{"sid": S2, "note": "later session", "at": "2026-10-12T00:00:00Z"}]
        with self.assertRaises(ValueError):
            merged(rec, {"assessments": [assess(status="implemented", evidence=ev)]})

    def test_history_skips_unchanged_and_stale_and_stays_bounded(self):
        rec = self.base()
        rec, _ = merged(rec, {"assessments": [assess()]})
        rec, rep = merged(rec, {"assessments": [assess(at="2026-10-11T00:00:00Z")]})
        self.assertEqual(rep["assessments_ignored"], [{"id": FID, "reason": "unchanged"}])
        rec, rep = merged(rec, {"assessments": [assess(note="Different", at="2026-10-05T00:00:00Z")]})
        self.assertEqual(rep["assessments_ignored"], [{"id": FID, "reason": "stale"}])
        for day in range(11, 25):
            rec, _ = merged(rec, {"assessments": [assess(note="Update %d" % day, at="2026-10-%02dT00:00:00Z" % day)]})
        f = rec["findings"][0]
        self.assertEqual(len(f["assessments"]), 10)
        self.assertEqual(f["assessment"], f["assessments"][-1])

    def test_still_issue_evidence_after_implementation_is_surfaced_as_recurrence(self):
        rec = self.base()
        rec, _ = merged(rec, {"decisions": [{"id": FID, "state": "implemented"}]}, now="2026-10-10T00:00:00Z")
        ev = [{"sid": S2, "note": "same friction again", "at": "2026-10-20T00:00:00Z"}]
        rec, rep = merged(rec, {"assessments": [assess(status="still_issue", note="Seen again.", evidence=ev,
                                                       at="2026-10-21T00:00:00Z")]}, "headless", now="2026-10-21T00:00:00Z")
        f = rec["findings"][0]
        self.assertEqual((f["state"], f["recurrence"], f["recurred_after_resolution"]), ("implemented", 2, 1))
        self.assertEqual(rep["recurred"], [FID])
        self.assertEqual(f["last_seen"], "2026-10-20T00:00:00Z")

    def test_improvement_evidence_is_counter_evidence_not_recurrence(self):
        rec = self.base()
        ev = [{"sid": S2, "note": "workflow ran cleanly", "at": "2026-10-12T00:00:00Z"}]
        rec, _ = merged(rec, {"assessments": [assess(status="improvement_observed", note="Ran without correction.", evidence=ev)]})
        f = rec["findings"][0]
        self.assertEqual((f["recurrence"], [c["sid"] for c in f["counter_evidence"]]), (1, [S2]))

    def test_answered_questions_are_cleared_but_remembered(self):
        rec = self.base(questions=["Is this a deliberate gate?", "Which repository owns it?"])
        rec, rep = merged(rec, {"assessments": [assess(answered_questions=["Is this a deliberate gate?", "Never asked"])]})
        f = rec["findings"][0]
        self.assertEqual(f["questions"], ["Which repository owns it?"])
        self.assertEqual([q["question"] for q in f["resolved_questions"]], ["Is this a deliberate gate?"])
        self.assertEqual(rep["questions_cleared"], [FID])

    def test_notes_are_privacy_checked(self):
        delta = {"assessments": [assess(note="see https://x.example.com/y", answered_questions=["ask a@b.example.com"])]}
        paths = {(h["path"], h["rule"]) for h in R.privacy_violations(delta, load_config())}
        self.assertIn(("assessments[0].note", "url"), paths)
        self.assertIn(("assessments[0].answered_questions[0]", "email"), paths)
        self.assertEqual({p for p, _ in paths if p.endswith(("status", ".at", ".id"))}, set())


class AssessedRenderTests(unittest.TestCase):
    def sections(self, text):
        out, current = {}, None
        for line in text.splitlines():
            if line.startswith("## "):
                current = line[3:]
                out[current] = []
            elif current:
                out[current].append(line)
        return {k: "\n".join(v) for k, v in out.items()}

    def test_assessed_findings_are_placed_by_what_is_known(self):
        rec, _ = merged(R.new_record(), {"findings": [
            finding(key="still-a-problem", title="Still", sid=S1),
            finding(key="wrong-diagnosis", title="Wrong", sid=S2),
            finding(key="fix-in-place", title="InPlace", sid=S3),
            finding(key="seems-better", title="Better", sid="d" * 16),
            finding(key="no-evidence-yet", title="Unknown", sid="e" * 16),
        ]})
        rec, _ = merged(rec, {"assessments": [
            assess("f-still-a-problem", "still_issue", "Seen again."),
            assess("f-wrong-diagnosis", "needs_correction", "Cause was overstated."),
            assess("f-fix-in-place", "implemented", "Change is in place."),
            assess("f-seems-better", "improvement_observed", "Ran cleanly."),
            assess("f-no-evidence-yet", "unknown", "Not exercised yet."),
        ]})
        sec = self.sections(R.render(rec))
        self.assertIn("**Still**", sec["Headline findings"])
        self.assertIn("**Unknown**", sec["Headline findings"])
        self.assertIn("unverified", sec["Headline findings"])
        for title in ("Wrong", "InPlace", "Better"):
            self.assertNotIn("**%s**" % title, sec["Headline findings"])
        self.assertIn("**Wrong**", sec["Diagnosis needs correction"])
        self.assertIn("**InPlace**", sec["Planned or awaiting validation"])
        self.assertIn("**Better**", sec["Planned or awaiting validation"])
        self.assertIn("improvement observed", sec["Planned or awaiting validation"])
        self.assertEqual(len(sec["Changed since the previous review"].strip().splitlines()), 5)

    def test_changed_since_follows_run_boundaries(self):
        review = lambda n: {"id": "r-%s" % n, "kind": "general", "summary": "run"}
        rec, _ = merged(R.new_record(), {"findings": [finding(title="First")], "review": review("one")}, now="2026-10-02T00:00:00Z")
        rec, _ = merged(rec, {"assessments": [assess()]}, "headless", now="2026-10-10T00:00:00Z")
        self.assertIn("## Changed since the previous review", R.render(rec))
        rec, _ = merged(rec, {"review": review("two")}, "headless", now="2026-10-11T00:00:00Z")
        self.assertIn("## Changed since the previous review", R.render(rec))
        rec, _ = merged(rec, {"review": review("three")}, "headless", now="2026-10-20T00:00:00Z")
        self.assertNotIn("Changed since the previous review", R.render(rec))

    def test_records_without_assessments_render_as_before(self):
        rec, _ = merged(R.new_record(), {"findings": [finding()]})
        text = R.render(rec)
        self.assertNotIn("Changed since", text)
        self.assertNotIn("needs correction", text)
        self.assertIn("## Headline findings", text)


if __name__ == "__main__":
    unittest.main()
