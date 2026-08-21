import { test } from "node:test"
import assert from "node:assert/strict"
import { SecretRedactorPlugin } from "../plugins/secret-redactor.ts"

// Fake secrets, built by concatenation so nothing secret-shaped sits in this
// file as a literal. None of these are real credentials.
const FAKE_GITHUB_PAT = "ghp_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF6hJ9"
const FAKE_AWS_KEY = "AKIA" + "Q7R2M3XBL4WPZ6TK"

async function loadPlugin() {
  return SecretRedactorPlugin({} as any)
}

test("tool.execute.after redacts a known secret pattern", async () => {
  const hooks = await loadPlugin()
  const output: any = { output: `token=${FAKE_GITHUB_PAT} ok`, title: "result", metadata: {} }
  await hooks["tool.execute.after"]!({} as any, output)
  assert.ok(!output.output.includes(FAKE_GITHUB_PAT))
  assert.ok(output.output.includes("[REDACTED]"))
})

test("chat.message redacts a secret pasted into a prompt", async () => {
  const hooks = await loadPlugin()
  const parts = [{ type: "text", text: `use ${FAKE_AWS_KEY} please` }]
  await hooks["chat.message"]!({} as any, { message: {} as any, parts } as any)
  assert.ok(!parts[0]!.text.includes(FAKE_AWS_KEY))
})

test("clean text passes through unchanged", async () => {
  const hooks = await loadPlugin()
  const output: any = { output: "just a normal log line\nnothing sensitive here", title: "ls", metadata: {} }
  const before = output.output
  await hooks["tool.execute.after"]!({} as any, output)
  assert.equal(output.output, before)
})

test("captures and redacts a live env-only secret secretlint would not recognize", async () => {
  process.env.SECRET_REDACTOR_TEST_TOKEN = "envSecretValue9f3ac1"
  const hooks = await loadPlugin() // re-captures env at instantiation time
  delete process.env.SECRET_REDACTOR_TEST_TOKEN
  const output: any = { output: "dump: envSecretValue9f3ac1 end", title: "env", metadata: {} }
  await hooks["tool.execute.after"]!({} as any, output)
  assert.ok(!output.output.includes("envSecretValue9f3ac1"))
})

test("tool.execute.before denies reading .env", async () => {
  const hooks = await loadPlugin()
  await assert.rejects(
    hooks["tool.execute.before"]!({ tool: "read" } as any, { args: { filePath: "/proj/.env" } } as any),
    /sensitive|credentials/i,
  )
})

test("tool.execute.before allows reading .env.example", async () => {
  const hooks = await loadPlugin()
  await assert.doesNotReject(
    hooks["tool.execute.before"]!({ tool: "read" } as any, { args: { filePath: "/proj/.env.example" } } as any),
  )
})

test("tool.execute.before denies a bare env/printenv dump", async () => {
  const hooks = await loadPlugin()
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash" } as any, { args: { command: "printenv" } } as any))
  await assert.rejects(hooks["tool.execute.before"]!({ tool: "bash" } as any, { args: { command: "env" } } as any))
})

test("tool.execute.before allows printenv with a variable name", async () => {
  const hooks = await loadPlugin()
  await assert.doesNotReject(
    hooks["tool.execute.before"]!({ tool: "bash" } as any, { args: { command: "printenv EDITOR" } } as any),
  )
})

test("history transform redacts a secret already persisted in tool output", async () => {
  const hooks = await loadPlugin()
  const messages = [
    {
      info: {},
      parts: [
        {
          type: "tool",
          state: {
            status: "completed",
            input: {},
            output: `leaked: ${FAKE_GITHUB_PAT}`,
            title: "printenv",
            metadata: {},
          },
        },
      ],
    },
  ]
  await hooks["experimental.chat.messages.transform"]!({} as any, { messages } as any)
  const state = (messages[0]!.parts[0] as any).state
  assert.ok(!state.output.includes(FAKE_GITHUB_PAT))
})

test("secretlint-disable comment does not suppress detection", async () => {
  const hooks = await loadPlugin()
  const output: any = { output: `// secretlint-disable\n${FAKE_GITHUB_PAT}`, title: "cat", metadata: {} }
  await hooks["tool.execute.after"]!({} as any, output)
  assert.ok(!output.output.includes(FAKE_GITHUB_PAT))
})

test("system prompt transform redacts secrets", async () => {
  const hooks = await loadPlugin()
  const output: any = { system: [`context includes ${FAKE_AWS_KEY}`] }
  await hooks["experimental.chat.system.transform"]!({} as any, output)
  assert.ok(!output.system[0].includes(FAKE_AWS_KEY))
})
