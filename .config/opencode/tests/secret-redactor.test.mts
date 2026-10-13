import { test } from "node:test"
import assert from "node:assert/strict"
import { Message } from "@opencode/ai"
import plugin from "../plugins/secret-redactor.ts"

// Fake secrets, built by concatenation so nothing secret-shaped sits in this
// file as a literal. None of these are real credentials.
const FAKE_GITHUB_PAT = "ghp_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF6hJ9"
const FAKE_AWS_KEY = "AKIA" + "Q7R2M3XBL4WPZ6TK"

type Hook = (event: any) => unknown

// Stands in for the plugin context: records every registered hook by domain and name.
async function loadPlugin() {
  const hooks = new Map<string, Hook>()
  const domain = (prefix: string) => ({
    hook: async (name: string, callback: Hook) => {
      hooks.set(`${prefix}:${name}`, callback)
      return { dispose: async () => {} }
    },
  })
  await plugin.setup({ session: domain("session"), tool: domain("tool") } as any)
  const hook = (key: string): Hook => {
    const callback = hooks.get(key)
    assert.ok(callback, `hook ${key} was not registered`)
    return callback
  }
  return { hooks, hook }
}

const completed = (result: any) => ({ tool: "shell", status: "completed", input: {}, result })

test("registers a hook for every kind of model request", async () => {
  const { hooks } = await loadPlugin()
  for (const name of ["prompt", "context", "compaction", "generate", "title"]) {
    assert.ok(hooks.has(`session:${name}`), name)
  }
  assert.ok(hooks.has("tool:execute.before"))
  assert.ok(hooks.has("tool:execute.after"))
})

test("tool execute.after redacts a known secret pattern", async () => {
  const { hook } = await loadPlugin()
  const event: any = completed({ content: `token=${FAKE_GITHUB_PAT} ok`, output: { text: FAKE_GITHUB_PAT }, metadata: { note: FAKE_AWS_KEY } })
  await hook("tool:execute.after")(event)
  assert.ok(!event.result.content.includes(FAKE_GITHUB_PAT))
  assert.ok(event.result.content.includes("[REDACTED]"))
  assert.ok(!JSON.stringify(event.result.output).includes(FAKE_GITHUB_PAT))
  assert.ok(!JSON.stringify(event.result.metadata).includes(FAKE_AWS_KEY))
})

test("tool execute.after redacts text parts of structured content", async () => {
  const { hook } = await loadPlugin()
  const file = { type: "file", uri: "file:///a.png", mime: "image/png" }
  const event: any = completed({ content: [{ type: "text", text: `leaked ${FAKE_GITHUB_PAT}` }, file] })
  await hook("tool:execute.after")(event)
  assert.ok(!event.result.content[0].text.includes(FAKE_GITHUB_PAT))
  assert.deepEqual(event.result.content[1], file)
})

test("prompt hook redacts a secret pasted into a prompt", async () => {
  const { hook } = await loadPlugin()
  const event: any = { prompt: { text: `use ${FAKE_AWS_KEY} please` }, delivery: "steer" }
  await hook("session:prompt")(event)
  assert.ok(!event.prompt.text.includes(FAKE_AWS_KEY))
})

test("prompt hook drops mention offsets once the text length changes", async () => {
  const { hook } = await loadPlugin()
  const mention = { start: 0, end: 3, text: "@a" }
  const event: any = { prompt: { text: `${FAKE_AWS_KEY} @a`, files: [{ uri: "file:///a", mention }], agents: [{ name: "x", mention }] } }
  await hook("session:prompt")(event)
  assert.equal(event.prompt.files[0].mention, undefined)
  assert.equal(event.prompt.agents[0].mention, undefined)
})

test("prompt hook leaves a clean prompt and its mentions alone", async () => {
  const { hook } = await loadPlugin()
  const mention = { start: 0, end: 2, text: "@a" }
  const event: any = { prompt: { text: "@a hello", files: [{ uri: "file:///a", mention }] } }
  await hook("session:prompt")(event)
  assert.equal(event.prompt.text, "@a hello")
  assert.deepEqual(event.prompt.files[0].mention, mention)
})

test("clean text passes through unchanged", async () => {
  const { hook } = await loadPlugin()
  const event: any = completed({ content: "just a normal log line\nnothing sensitive here" })
  await hook("tool:execute.after")(event)
  assert.equal(event.result.content, "just a normal log line\nnothing sensitive here")
})

test("captures and redacts a live env-only secret secretlint would not recognize", async () => {
  process.env.SECRET_REDACTOR_TEST_TOKEN = "envSecretValue9f3ac1"
  const { hook } = await loadPlugin() // re-captures env at setup time
  delete process.env.SECRET_REDACTOR_TEST_TOKEN
  const event: any = completed({ content: "dump: envSecretValue9f3ac1 end" })
  await hook("tool:execute.after")(event)
  assert.ok(!event.result.content.includes("envSecretValue9f3ac1"))
})

test("tool execute.before denies reading .env", async () => {
  const { hook } = await loadPlugin()
  const before = hook("tool:execute.before")
  await assert.rejects(async () => before({ tool: "read", input: { path: "/proj/.env" } }), /credentials/i)
  await assert.rejects(async () => before({ tool: "read", input: { filePath: "/proj/.env" } }), /credentials/i)
})

test("tool execute.before allows reading .env.example", async () => {
  const { hook } = await loadPlugin()
  await assert.doesNotReject(async () => hook("tool:execute.before")({ tool: "read", input: { path: "/proj/.env.example" } }))
})

test("tool execute.before denies a bare env/printenv dump", async () => {
  const { hook } = await loadPlugin()
  const before = hook("tool:execute.before")
  await assert.rejects(async () => before({ tool: "shell", input: { command: "printenv" } }))
  await assert.rejects(async () => before({ tool: "shell", input: { command: "env" } }))
})

test("tool execute.before allows printenv with a variable name", async () => {
  const { hook } = await loadPlugin()
  await assert.doesNotReject(async () => hook("tool:execute.before")({ tool: "shell", input: { command: "printenv EDITOR" } }))
})

test("context hook redacts a secret already persisted in tool history", async () => {
  const { hook } = await loadPlugin()
  const messages = [
    Message.assistant([{ type: "tool-call", id: "c1", name: "shell", input: { command: `echo ${FAKE_AWS_KEY}` } }]),
    Message.tool({ id: "c1", name: "shell", result: { leaked: FAKE_GITHUB_PAT }, resultType: "json" }),
    Message.tool({ id: "c2", name: "shell", result: `leaked: ${FAKE_GITHUB_PAT}`, resultType: "text" }),
    Message.user(`and in a prompt: ${FAKE_GITHUB_PAT}`),
    Message.assistant([{ type: "reasoning", text: `thinking about ${FAKE_GITHUB_PAT}` }]),
  ]
  await hook("session:context")({ system: [], messages })
  const serialized = JSON.stringify(messages)
  assert.ok(!serialized.includes(FAKE_GITHUB_PAT))
  assert.ok(!serialized.includes(FAKE_AWS_KEY))
  assert.ok(serialized.includes("[REDACTED]"))
})

test("context hook leaves clean history untouched", async () => {
  const { hook } = await loadPlugin()
  const messages = [Message.user("hello"), Message.assistant("hi there")]
  const before = JSON.stringify(messages)
  await hook("session:context")({ system: [{ type: "text", text: "be helpful" }], messages })
  assert.equal(JSON.stringify(messages), before)
})

test("compaction, generate and title hooks redact too", async () => {
  const { hook } = await loadPlugin()
  for (const name of ["compaction", "generate", "title"]) {
    const messages = [Message.user(`key ${FAKE_AWS_KEY}`)]
    await hook(`session:${name}`)({ system: [], messages })
    assert.ok(!JSON.stringify(messages).includes(FAKE_AWS_KEY), name)
  }
})

test("secretlint-disable comment does not suppress detection", async () => {
  const { hook } = await loadPlugin()
  const event: any = completed({ content: `// secretlint-disable\n${FAKE_GITHUB_PAT}` })
  await hook("tool:execute.after")(event)
  assert.ok(!event.result.content.includes(FAKE_GITHUB_PAT))
})

test("system prompt is redacted", async () => {
  const { hook } = await loadPlugin()
  const event: any = { system: [{ type: "text", text: `context includes ${FAKE_AWS_KEY}` }], messages: [] }
  await hook("session:context")(event)
  assert.ok(!event.system[0].text.includes(FAKE_AWS_KEY))
})

test("tool execute.after redacts a failure message", async () => {
  const { hook } = await loadPlugin()
  const event: any = { tool: "shell", status: "error", input: {}, error: { message: `failed with ${FAKE_GITHUB_PAT}` } }
  await hook("tool:execute.after")(event)
  assert.ok(!event.error.message.includes(FAKE_GITHUB_PAT))
})

test("redactText scrubs a secret for callers outside any session hook", async () => {
  const { redactText } = await import("../plugins/secret-redactor.ts")
  const out = await redactText(`please use ${FAKE_GITHUB_PAT} now`)
  assert.ok(!out.includes(FAKE_GITHUB_PAT))
  assert.ok(out.includes("[REDACTED]"))
})

test("a later load does not reuse a result cached before a value became a known secret", async () => {
  const text = "value: lateSecretValue7c1d"
  const first = await loadPlugin()
  const before: any = completed({ content: text })
  await first.hook("tool:execute.after")(before)
  assert.equal(before.result.content, text, "not a secret yet, so unchanged")

  process.env.SECRET_REDACTOR_LATE_TOKEN = "lateSecretValue7c1d"
  const second = await loadPlugin()
  delete process.env.SECRET_REDACTOR_LATE_TOKEN
  const after: any = completed({ content: text })
  await second.hook("tool:execute.after")(after)
  assert.ok(!after.result.content.includes("lateSecretValue7c1d"))
})
