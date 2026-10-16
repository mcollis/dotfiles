import { test, after } from "node:test"
import assert from "node:assert/strict"
import { Media, Message } from "@opencode/ai"
import { fileURLToPath } from "node:url"
import plugin from "../plugins/secret-redactor.ts"
import { createScanService, setSharedScanService } from "../lib/secret-redactor/service.ts"

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

const WITHHELD_MARKER = "[secret-redactor: output withheld"
const FAKE_SCANNER = fileURLToPath(new URL("./fixtures/fake-scanner.mjs", import.meta.url))

function nested(depth: number) {
  const root: any = {}
  let current = root
  for (let i = 0; i < depth; i++) current = current.next = {}
  return root
}

after(() => setSharedScanService(undefined))

test("an oversized tool result is withheld instead of scanned or forwarded", async () => {
  const { hook } = await loadPlugin()
  const event: any = completed({ content: "a".repeat(600 * 1024) })
  await hook("tool:execute.after")(event)
  assert.ok(event.result.content.startsWith(WITHHELD_MARKER))
})

test("a request beyond the traversal limits is rejected and left unmodified", async () => {
  const { hook } = await loadPlugin()
  const text = { type: "text", text: `key ${FAKE_AWS_KEY}` }
  const messages = [{ content: [text, { type: "tool-call", id: "c1", name: "shell", input: nested(80) }] }]
  await assert.rejects(hook("session:context")({ system: [], messages }), /exceeds redaction limits/)
  assert.equal(text.text, `key ${FAKE_AWS_KEY}`, "nothing was partially rewritten")
})

test("a tool result beyond the traversal limits is replaced and its metadata dropped", async () => {
  const { hook } = await loadPlugin()
  const event: any = completed({ content: "visible", output: nested(80), metadata: { note: "n" } })
  await hook("tool:execute.after")(event)
  assert.ok(event.result.content.startsWith(WITHHELD_MARKER))
  assert.ok(event.result.output.startsWith(WITHHELD_MARKER))
  assert.equal("metadata" in event.result, false)
})

test("a tool failure beyond the limits has its message replaced and metadata cleared", async () => {
  const { hook } = await loadPlugin()
  const event: any = { tool: "shell", status: "error", input: {}, error: { message: "m".repeat(600 * 1024), metadata: { a: 1 } } }
  await hook("tool:execute.after")(event)
  assert.ok(event.error.message.startsWith(WITHHELD_MARKER))
  assert.equal(event.error.metadata, undefined)
})

test("a scanner failure withholds the text rather than forwarding it", async () => {
  setSharedScanService(createScanService({ scannerPath: FAKE_SCANNER, limits: { cooldownMs: 50 } }))
  try {
    const { hook } = await loadPlugin()
    const event: any = completed({ content: "crash now" })
    await hook("tool:execute.after")(event)
    assert.ok(event.result.content.startsWith(WITHHELD_MARKER))
    assert.ok(!event.result.content.includes("crash now"))
  } finally {
    setSharedScanService(undefined)
  }
})

test("the plugin returns a cleanup that releases the scanner", async () => {
  const hooks = new Map<string, Hook>()
  const domain = (prefix: string) => ({ hook: async (name: string, cb: Hook) => void hooks.set(`${prefix}:${name}`, cb) })
  const cleanup = await plugin.setup({ session: domain("session"), tool: domain("tool") } as any)
  assert.equal(typeof cleanup, "function")
  ;(cleanup as () => void)()
})

// A shared-service stand-in whose scan moves the clock past the operation deadline.
function expiringScanner() {
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  const service: any = {
    scan: async () => {
      offset = 60_000
      return "scanned"
    },
    retain() {},
    release() {},
    close() {},
  }
  return { service, restore: () => void (Date.now = realNow) }
}

test("a request that outlives its deadline is rejected and nothing is committed", async () => {
  const { service, restore } = expiringScanner()
  setSharedScanService(service)
  try {
    const { hook } = await loadPlugin()
    const first = { type: "text", text: "first" }
    const second = { type: "text", text: "second" }
    await assert.rejects(hook("session:context")({ system: [], messages: [{ content: [first, second] }] }), /exceeds redaction limits/)
    assert.equal(first.text, "first")
    assert.equal(second.text, "second")
  } finally {
    restore()
    setSharedScanService(undefined)
  }
})

test("a tool result that outlives its deadline is withheld", async () => {
  const { service, restore } = expiringScanner()
  setSharedScanService(service)
  try {
    const { hook } = await loadPlugin()
    const event: any = completed({ content: "visible", metadata: { a: 1 } })
    await hook("tool:execute.after")(event)
    assert.ok(event.result.content.startsWith(WITHHELD_MARKER))
    assert.equal("metadata" in event.result, false)
  } finally {
    restore()
    setSharedScanService(undefined)
  }
})

test("redactText withholds when its deadline passes", async () => {
  const { service, restore } = expiringScanner()
  setSharedScanService(service)
  try {
    const { redactText } = await import("../plugins/secret-redactor.ts")
    assert.ok((await redactText("some text")).startsWith(WITHHELD_MARKER))
  } finally {
    restore()
    setSharedScanService(undefined)
  }
})

test("a message with many empty or unrecognized parts hits the node limit", async () => {
  const { hook } = await loadPlugin()
  const parts = Array.from({ length: 25_000 }, () => ({ type: "image" }))
  await assert.rejects(hook("session:context")({ system: [], messages: [{ content: parts }] }), /exceeds redaction limits/)
})

test("oversized structured tool content is replaced by a single marker part", async () => {
  const { hook } = await loadPlugin()
  const file = { type: "file", uri: "file:///a.png", mime: "image/png" }
  const event: any = completed({ content: Array.from({ length: 25_000 }, () => file) })
  await hook("tool:execute.after")(event)
  assert.equal(event.result.content.length, 1)
  assert.ok(event.result.content[0].text.startsWith(WITHHELD_MARKER))
})

test("a wide object is cut off by the node limit rather than copied whole", async () => {
  const { hook } = await loadPlugin()
  const wide: Record<string, string> = {}
  for (let i = 0; i < 25_000; i++) wide[`k${i}`] = "v"
  const event: any = completed({ content: "x", output: wide })
  await hook("tool:execute.after")(event)
  assert.ok(event.result.output.startsWith(WITHHELD_MARKER))
})

const bigBase64 = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString("base64")
const dataUrl = (mime: string, bytes: number) => `data:${mime};base64,${bigBase64(bytes)}`
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]

const readResult = (output: any) => ({ tool: "read", status: "completed", input: {}, result: { output, content: "Image read successfully" } })
const fileOutput = (over: Record<string, unknown> = {}) => ({
  type: "file",
  uri: "file:///work/shot.png",
  name: "shot.png",
  content: bigBase64(900_000),
  encoding: "base64",
  mime: "image/png",
  ...over,
})

test("typed media file parts in tool history keep their payload at any size", async () => {
  const { hook } = await loadPlugin()
  for (const mime of MEDIA_TYPES) {
    for (const bytes of [50_000, 400_000, 900_000]) {
      const uri = dataUrl(mime, bytes)
      const messages = [
        { content: [{ type: "tool-result", id: "c", name: "read", result: { type: "content", value: [{ type: "text", text: "Image read successfully" }, { type: "file", uri, mime, name: "a" }] } }] },
      ]
      await hook("session:context")({ system: [], messages })
      assert.equal((messages[0].content[0] as any).result.value[1].uri, uri, `${mime} ${bytes}`)
    }
  }
})

test("a media file part's name is still scanned while its payload is kept", async () => {
  const { hook } = await loadPlugin()
  const uri = dataUrl("image/png", 100_000)
  const messages = [
    { content: [{ type: "tool-result", id: "c", name: "read", result: { type: "content", value: [{ type: "file", uri, mime: "image/png", name: `${FAKE_GITHUB_PAT}.png` }] } }] },
  ]
  await hook("session:context")({ system: [], messages })
  const part = (messages[0].content[0] as any).result.value[0]
  assert.equal(part.uri, uri)
  assert.ok(!part.name.includes(FAKE_GITHUB_PAT))
})

test("a media file part in a fresh tool result keeps its payload; adjacent text is scanned", async () => {
  const { hook } = await loadPlugin()
  const uri = dataUrl("image/jpeg", 700_000)
  const event: any = completed({
    content: [
      { type: "text", text: `Image read successfully ${FAKE_GITHUB_PAT}` },
      { type: "file", uri, mime: "image/jpeg", name: "p.jpg" },
    ],
  })
  await hook("tool:execute.after")(event)
  assert.equal(event.result.content[1].uri, uri)
  assert.ok(!event.result.content[0].text.includes(FAKE_GITHUB_PAT))
})

test("the read tool's base64 output keeps its content; its other fields are scanned", async () => {
  const { hook } = await loadPlugin()
  const output = fileOutput({ name: `${FAKE_GITHUB_PAT}.png` })
  const content = output.content
  const event: any = readResult(output)
  await hook("tool:execute.after")(event)
  assert.equal(event.result.output.content, content)
  assert.ok(!event.result.output.name.includes(FAKE_GITHUB_PAT))
  assert.equal(event.result.output.encoding, "base64")
})

test("a read result recorded as json in history keeps its base64 content", async () => {
  const { hook } = await loadPlugin()
  const output = fileOutput()
  const messages = [{ content: [{ type: "tool-result", id: "c", name: "read", result: { type: "json", value: output } }] }]
  await hook("session:context")({ system: [], messages })
  assert.equal((messages[0].content[0] as any).result.value.content, output.content)
})

test("a captured env secret inside an exempt payload is not rewritten, since that would corrupt the media", async () => {
  process.env.SECRET_REDACTOR_MEDIA_TOKEN = "mediaSecretValue5e2b"
  const { hook } = await loadPlugin()
  delete process.env.SECRET_REDACTOR_MEDIA_TOKEN
  const uri = `${dataUrl("image/png", 1_000)}mediaSecretValue5e2b`
  const event: any = completed({ content: [{ type: "file", uri, mime: "image/png" }] })
  await hook("tool:execute.after")(event)
  assert.equal(event.result.content[0].uri, uri)
})

test("strings that merely look like media get no exemption", async () => {
  const { hook } = await loadPlugin()
  const big = dataUrl("image/png", 600_000)

  const prompt: any = { prompt: { text: big } }
  await hook("session:prompt")(prompt)
  assert.ok(prompt.prompt.text.startsWith(WITHHELD_MARKER), "prompt text")

  const generic: any = completed({ content: "ok", output: { image: big }, metadata: { preview: big } })
  await hook("tool:execute.after")(generic)
  assert.ok(generic.result.output.image.startsWith(WITHHELD_MARKER), "generic output")
  assert.ok(generic.result.metadata.preview.startsWith(WITHHELD_MARKER), "metadata")

  const plain: any = completed({ content: "A".repeat(600 * 1024) })
  await hook("tool:execute.after")(plain)
  assert.ok(plain.result.content.startsWith(WITHHELD_MARKER), "long plain run")

  const pasted: any = completed({ content: `iVBORw0KGgo then a token ${FAKE_GITHUB_PAT}` })
  await hook("tool:execute.after")(pasted)
  assert.ok(!pasted.result.content.includes(FAKE_GITHUB_PAT), "text that starts like an image")
})

test("lookalike file objects outside the verified shapes get no exemption", async () => {
  const { hook } = await loadPlugin()
  const big = bigBase64(900_000)

  const notRead: any = completed({ content: "ok", output: fileOutput() })
  await hook("tool:execute.after")(notRead)
  assert.ok(notRead.result.output.content.startsWith(WITHHELD_MARKER), "same shape from another tool")

  for (const [label, over] of [
    ["utf8 encoding", { encoding: "utf8", mime: "text/plain", content: "A".repeat(600 * 1024) }],
    ["unsupported mime", { mime: "application/zip" }],
    ["not a string", { content: 5 }],
  ] as const) {
    const event: any = readResult(fileOutput(over))
    await hook("tool:execute.after")(event)
    if (label === "not a string") assert.equal(event.result.output.content, 5, label)
    else assert.ok(event.result.output.content.startsWith(WITHHELD_MARKER), label)
  }

  const mismatched: any = completed({ content: [{ type: "file", uri: `data:image/jpeg;base64,${big}`, mime: "image/png" }] })
  await hook("tool:execute.after")(mismatched)
  assert.ok(mismatched.result.content[0].uri.startsWith(WITHHELD_MARKER), "mime does not match the data URL")

  const unsupported: any = completed({ content: [{ type: "file", uri: `data:application/zip;base64,${big}`, mime: "application/zip" }] })
  await hook("tool:execute.after")(unsupported)
  assert.ok(unsupported.result.content[0].uri.startsWith(WITHHELD_MARKER), "unsupported type")

  const input = [{ content: [{ type: "tool-call", id: "c", name: "write", input: { data: dataUrl("image/png", 600_000) } }] }]
  await hook("session:context")({ system: [], messages: input })
  assert.ok((input[0].content[0] as any).input.data.startsWith(WITHHELD_MARKER), "tool-call input")
})

test("direct media assets are left as the same object", async () => {
  const { hook } = await loadPlugin()
  const asset = Media.base64(bigBase64(300_000), "image/png")
  const part = { type: "media", media: asset }
  await hook("session:context")({ system: [], messages: [{ content: [part] }] })
  assert.equal(part.media, asset)
  assert.equal(part.type, "media")
})

test("a preserved data URL still decodes to the original bytes", async () => {
  const { hook } = await loadPlugin()
  const bytes = Buffer.from(Array.from({ length: 5_000 }, (_, i) => (i * 31) % 256))
  const uri = `data:image/png;base64,${bytes.toString("base64")}`
  const messages = [{ content: [{ type: "tool-result", id: "c", name: "read", result: { type: "content", value: [{ type: "file", uri, mime: "image/png" }] } }] }]
  await hook("session:context")({ system: [], messages })
  const kept = (messages[0].content[0] as any).result.value[0].uri
  const asset = Media.parseDataUrl(kept)
  assert.ok(asset)
  assert.ok(Buffer.from(asset.inline()!.base64, "base64").equals(bytes))
})
