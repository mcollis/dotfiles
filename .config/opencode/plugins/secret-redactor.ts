import { Plugin } from "@opencode/plugin"
import { lintSource } from "@secretlint/core"
import { rules as presetRules } from "@secretlint/secretlint-rule-preset-recommend"
import type { SecretLintCoreConfig } from "@secretlint/types"

// Redacts credentials from everything OpenCode sends to the model:
// - prompts (session "prompt" hook), tool output (tool "execute.after"), and the
//   full system prompt and history resent on every request (session "context"
//   hook, plus "compaction", "generate" and "title" which each run separately)
// - the context hooks are what cover a raw `!` shell result once it's no longer
//   the newest message: OpenCode's per-tool hooks only fire for AI-invoked tools,
//   not user-run shell commands, so history reprocessing is the real backstop.
//
// Two independent layers, in order:
// 1. Exact-match redaction of live process.env values that look like secrets
//    (name matches TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL). Catches the specific
//    tokens this machine actually holds, including ones no scanner recognizes.
// 2. Secretlint's maintained rule set (GitHub/GitLab/AWS/private keys/etc.) for
//    everything else, e.g. a token pasted into a prompt that isn't in our env.
//
// Fail-closed: if scanning throws, or a captured secret value still appears
// verbatim in the result, the text is withheld rather than forwarded raw.
//
// Known gap: this stops secrets from reaching the model. It does not remove
// raw shell output already written to opencode's local session database by
// the time these hooks run — only from what leaves this process afterward.

const REDACTED = "[REDACTED]"
const WITHHELD = "[secret-redactor: output withheld — could not verify it was free of secrets]"

const FILTER_COMMENTS_RULE_ID = "@secretlint/secretlint-rule-filter-comments"

// The AWS rule only scans for `AWS_SECRET_ACCESS_KEY=<value>`-style
// assignments by default; bare AKIA... access key IDs need this option
// (secretlint's own default is off, presumably to reduce false positives on
// a wider net — worth the tradeoff here since a bare key ID is still
// sensitive and this scans in-memory strings, not a whole repo).
const RULE_OPTIONS: Record<string, Record<string, unknown>> = {
  "@secretlint/secretlint-rule-aws": { enableIDScanRule: true },
}

// Excludes secretlint-rule-filter-comments: it honors a `secretlint-disable`
// marker anywhere in the scanned text, which would let untrusted message
// content (a prompt, a tool result) suppress detection of its own secrets.
const SCAN_CONFIG: SecretLintCoreConfig = {
  rules: presetRules
    .filter((rule) => rule.meta.id !== FILTER_COMMENTS_RULE_ID)
    .map((rule) => ({ id: rule.meta.id, rule, options: RULE_OPTIONS[rule.meta.id] })),
}

const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|_KEY$|_PWD$)/i
const MIN_SECRET_LENGTH = 6

function captureEnvSecrets(): string[] {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue
    if (!SENSITIVE_ENV_NAME.test(name)) continue
    values.add(value)
  }
  // Longest first: if one captured value is a prefix of another, redacting
  // the longer one first avoids leaving a mangled remainder of the shorter.
  return Array.from(values).sort((a, b) => b.length - a.length)
}

function redactExactValues(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

function mergeRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = ranges.map(([start, end]) => [start, end] as [number, number]).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push(range)
    }
  }
  return merged
}

async function scanWithSecretlint(text: string): Promise<string> {
  let result
  try {
    result = await lintSource({
      source: {
        filePath: "opencode-context.txt",
        content: text,
        ext: ".txt",
        contentType: "text",
      },
      options: {
        config: SCAN_CONFIG,
        noPhysicFilePath: true,
        maskSecrets: true,
      },
    })
  } catch {
    return WITHHELD
  }
  if (result.messages.length === 0) return text
  let out = text
  for (const [start, end] of mergeRanges(result.messages.map((m) => m.range)).reverse()) {
    out = out.slice(0, start) + REDACTED + out.slice(end)
  }
  return out
}

// Memoized on the exact input string *per captured secret set*: the mapping is
// only pure for a fixed set, and each plugin load captures its own. Sharing one
// cache across sets would let a later load reuse a result computed before a
// value became a known secret. This matters because the history transform hook
// rescans the entire active context on every turn.
const sanitizeCaches = new WeakMap<string[], Map<string, string>>()
const MAX_CACHE_ENTRIES = 5000

async function sanitizeText(text: string, secrets: string[]): Promise<string> {
  if (!text) return text
  let sanitizeCache = sanitizeCaches.get(secrets)
  if (!sanitizeCache) sanitizeCaches.set(secrets, (sanitizeCache = new Map()))
  const cached = sanitizeCache.get(text)
  if (cached !== undefined) return cached

  const afterExact = redactExactValues(text, secrets)
  const afterScan = await scanWithSecretlint(afterExact)
  // Fail-closed verification: a captured env secret should never survive both
  // passes. If one does (e.g. it appeared only after scanning altered offsets),
  // withhold rather than forward it.
  const result = secrets.some((secret) => secret && afterScan.includes(secret)) ? WITHHELD : afterScan

  if (sanitizeCache.size >= MAX_CACHE_ENTRIES) sanitizeCache.clear()
  sanitizeCache.set(text, result)
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Returns a redacted copy of strings, arrays and plain objects; anything else
// (class instances, binary data) passes through untouched. A cyclic structure
// cannot be copied, so it is withheld rather than forwarded unscanned.
async function redactValue(value: unknown, secrets: string[], ancestors = new Set<object>()): Promise<unknown> {
  if (typeof value === "string") return sanitizeText(value, secrets)
  if (!value || typeof value !== "object") return value
  const isArray = Array.isArray(value)
  if (!isArray && !isPlainObject(value)) return value
  if (ancestors.has(value)) return WITHHELD

  ancestors.add(value)
  try {
    if (isArray) {
      const out: unknown[] = []
      for (const item of value) out.push(await redactValue(item, secrets, ancestors))
      return out
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = await redactValue(item, secrets, ancestors)
    return out
  } finally {
    ancestors.delete(value)
  }
}

const SENSITIVE_PATH_SNIPPETS = [
  ".env",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  ".pem",
  ".key",
  ".aws/",
  ".ssh/",
  ".kube/config",
  ".npmrc",
  ".netrc",
  "credentials.json",
]
const EXEMPT_PATH_SUFFIXES = [".env.example", ".env.sample", ".env.template", ".pub"]

function looksSensitivePath(path: string): boolean {
  const lower = path.toLowerCase()
  if (EXEMPT_PATH_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false
  return SENSITIVE_PATH_SNIPPETS.some((snippet) => lower.includes(snippet))
}

// Catches the literal incident from this session: `printenv` or `env` with no
// variable name dumps everything. This is necessarily a static, best-effort
// check — it can't see shell expansion, so `printenv $UNSET_VAR` (which is how
// the original leak happened) still runs. Post-execution redaction in
// tool.execute.after and the history transform is what actually catches that
// case; this guard just stops the obviously-bare form before it runs at all.
function isBareEnvDump(command: string): boolean {
  for (const segment of command.split(/[;&|]+|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const head = (tokens[0] ?? "").replace(/^.*\//, "")
    if (head !== "env" && head !== "printenv") continue
    const args = tokens.slice(1).filter((t) => !t.startsWith("-"))
    if (args.length === 0) return true
  }
  return false
}

// The shapes below are the parts of OpenCode's request types this plugin edits.
// They are loose on purpose: parts are mutated in place and a field that is
// absent or of another type is simply skipped.
type Part = Record<string, any>
interface RequestEvent {
  system: Part[]
  messages: { content: Part[] }[]
}

async function redactMessagePart(part: Part, secrets: string[]): Promise<void> {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "compaction":
      if (typeof part.text === "string") part.text = await sanitizeText(part.text, secrets)
      break
    case "tool-call":
      part.input = await redactValue(part.input, secrets)
      break
    case "tool-result":
      if (part.result && typeof part.result === "object") {
        part.result = { ...part.result, value: await redactValue(part.result.value, secrets) }
      }
      break
  }
}

async function redactRequest(event: RequestEvent, secrets: string[]): Promise<void> {
  for (const part of event.system ?? []) {
    if (typeof part.text === "string") part.text = await sanitizeText(part.text, secrets)
  }
  for (const message of event.messages ?? []) {
    for (const part of message.content ?? []) await redactMessagePart(part, secrets)
  }
}

async function redactToolContent(content: unknown, secrets: string[]): Promise<unknown> {
  if (typeof content === "string") return sanitizeText(content, secrets)
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const part of content) {
    out.push(
      part && part.type === "text" && typeof part.text === "string"
        ? { ...part, text: await sanitizeText(part.text, secrets) }
        : part,
    )
  }
  return out
}

function stripMentions(items: Part[] | undefined): void {
  for (const item of items ?? []) delete item.mention
}

// For callers that send text to a model outside any session hook (the `ex`
// checkpoint renderer uses ctx.generate.text, which no session hook sees).
// Uses the environment secrets captured on first use.
let sharedSecrets: string[] | undefined
export function redactText(text: string): Promise<string> {
  sharedSecrets ??= captureEnvSecrets()
  return sanitizeText(text, sharedSecrets)
}

export default Plugin.define({
  id: "secret-redactor",
  async setup(ctx) {
    const secrets = captureEnvSecrets()

    await ctx.session.hook("prompt", async (event) => {
      const original = event.prompt.text
      if (typeof original !== "string") return
      const redacted = await sanitizeText(original, secrets)
      if (redacted === original) return
      event.prompt.text = redacted
      // Redaction changes the text's length, so recorded mention offsets no longer line up.
      stripMentions(event.prompt.files)
      stripMentions(event.prompt.agents)
      stripMentions(event.prompt.skills)
    })

    // Each kind of model request has its own hook; a redaction that should apply
    // to every request has to be registered for all of them.
    const redact = (event: unknown) => redactRequest(event as RequestEvent, secrets)
    await ctx.session.hook("context", redact)
    await ctx.session.hook("compaction", redact)
    await ctx.session.hook("generate", redact)
    await ctx.session.hook("title", redact)

    await ctx.tool.hook("execute.before", (event) => {
      const input = (event.input ?? {}) as Record<string, unknown>

      if (event.tool === "read") {
        const target = [input.path, input.filePath].find((value): value is string => typeof value === "string")
        if (target && looksSensitivePath(target)) {
          throw new Error(
            `secret-redactor: refusing to read '${target}' — looks like a credentials file. Its contents must not enter the model context. If this is safe, rename/copy it outside the sensitive-path patterns first.`,
          )
        }
      }

      if (event.tool === "shell") {
        const command = typeof input.command === "string" ? input.command : ""
        if (command && isBareEnvDump(command)) {
          throw new Error(
            "secret-redactor: bare 'env'/'printenv' dumps the entire environment, including credentials. Specify a variable name, e.g. `printenv EDITOR`.",
          )
        }
      }
    })

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.status === "completed") {
        const { content, output, metadata } = event.result
        event.result = {
          ...event.result,
          ...(content !== undefined && { content: (await redactToolContent(content, secrets)) as typeof content }),
          ...(output !== undefined && { output: await redactValue(output, secrets) }),
          ...(metadata !== undefined && { metadata: (await redactValue(metadata, secrets)) as typeof metadata }),
        }
        return
      }
      // A failure's message is also resent as a tool result, which the context
      // hooks above redact, so this is a best-effort first pass.
      const error = event.error as { message: string; metadata?: unknown }
      try {
        error.message = await sanitizeText(error.message, secrets)
      } catch {
        // Read-only error object; the context hooks still cover it.
      }
    })
  },
})
