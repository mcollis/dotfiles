---
description: Plan a Jira ticket with Opus 5.5 high in a child session
agent: plan
model: amazon-bedrock/us.anthropic.claude-opus-5-5#high
subagent: true
---

Load the `plan-ticket` skill and follow it for: $ARGUMENTS

Return the rendered ticket snapshot as the plan. Do not implement, commit, push, or mutate Jira/GitLab.
