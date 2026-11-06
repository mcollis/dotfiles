#!/usr/bin/env python3
"""Stand-in for `opencode api get <path>` serving two synthetic sessions."""
import json
import sys
import urllib.parse

args = sys.argv[1:]
if args[:2] != ["api", "get"]:
    sys.exit(2)
url = urllib.parse.urlparse(args[2])
q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
limit = int(q.get("limit", "50"))
start = int(q["cursor"].split(":")[1]) if "cursor" in q else 0


def page(rows):
    chunk = rows[start:start + limit]
    return {"data": chunk, "cursor": {"next": "idx:%d" % (start + limit)}}


SESSIONS = [
    {"id": "ses_new", "title": "Recent work", "agent": "build",
     "model": {"providerID": "p", "id": "m"}, "location": {"directory": "/work/a"},
     "time": {"created": 1_700_000_500_000, "updated": 1_700_000_900_000}},
    {"id": "ses_child", "parentID": "ses_new", "title": "child",
     "time": {"created": 1_700_000_600_000, "updated": 1_700_000_700_000}},
    {"id": "ses_old", "title": "Old", "time": {"created": 1_600_000_000_000, "updated": 1_600_000_100_000}},
]
MESSAGES = [
    {"id": "m1", "type": "user", "time": {"created": 1_700_000_510_000}, "text": "plan this", "files": []},
    {"id": "m2", "type": "assistant", "time": {"created": 1_700_000_520_000}, "content": [
        {"type": "reasoning", "text": ""},
        {"type": "text", "text": "Here is a plan."},
        {"type": "text", "text": "x" * 200000},
        {"type": "tool", "name": "shell", "state": {"status": "completed", "input": {"command": "ls"}}},
    ]},
    {"id": "m3", "type": "user", "time": {"created": 1_700_000_800_000}, "text": "too much, slim it down",
     "skills": [{"id": "x", "name": "plan-ticket", "text": "HUGE BODY"}]},
]

if url.path == "/api/info":
    print(json.dumps({"version": "test"}))
elif url.path == "/api/session":
    print(json.dumps(page(SESSIONS)))
elif url.path.endswith("/message"):
    print(json.dumps(page(MESSAGES)))
else:
    sys.exit(3)
