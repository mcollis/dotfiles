import type { Plugin } from "@opencode-ai/plugin"
import { lintSource } from "@secretlint/core"
import { rules as presetRules } from "@secretlint/secretlint-rule-preset-recommend"
import type { SecretLintCoreConfig } from "@secretlint/types"

// Redacts credentials from everything OpenCode sends to the model:
// - prompts (chat.message), tool output (tool.execute.after), and the full
//   active-context history resent on every turn (experimental.chat.messages.transform)
// - the last hook is what covers a raw `!` shell result once it's no longer the
//   newest message: OpenCode's per-tool hooks only fire for AI-invoked tools,
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

// Memoized on the exact input string: given a fixed env-secret set (captured
// once per process), the mapping is pure. This matters because the history
// transform hook rescans the entire active context on every turn.
const sanitizeCache = new Map<string, string>()
const MAX_CACHE_ENTRIES = 5000

async function sanitizeText(text: string, secrets: string[]): Promise<string> {
  if (!text) return text
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

// Mutates in place (OpenCode's hook contract only honors in-place edits to
// args/output objects, not wholesale replacement) and guards against cycles.
async function redactDeep(value: unknown, secrets: string[], seen = new WeakSet<object>()): Promise<void> {
  if (!value || typeof value !== "object") return
  if (seen.has(value as object)) return
  seen.add(value as object)

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (typeof item === "string") value[i] = await sanitizeText(item, secrets)
      else if (item && typeof item === "object") await redactDeep(item, secrets, seen)
    }
    return
  }

  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (typeof item === "string") value[key] = await sanitizeText(item, secrets)
    else if (item && typeof item === "object") await redactDeep(item, secrets, seen)
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

export const SecretRedactorPlugin: Plugin = async (_ctx) => {
  const secrets = captureEnvSecrets()

  return {
    "chat.message": async (_input, output) => {
      const parts = output.parts
      if (!Array.isArray(parts)) return
      for (const part of parts) {
        const p = part as { text?: unknown }
        if (typeof p.text === "string") p.text = await sanitizeText(p.text, secrets)
      }
    },

    "tool.execute.before": async (input, output) => {
      const args = (output.args ?? {}) as Record<string, unknown>

      if (input.tool === "read") {
        const target = typeof args.filePath === "string" ? args.filePath : undefined
        if (target && looksSensitivePath(target)) {
          throw new Error(
            `secret-redactor: refusing to read '${target}' — looks like a credentials file. Its contents must not enter the model context. If this is safe, rename/copy it outside the sensitive-path patterns first.`,
          )
        }
      }

      if (input.tool === "bash") {
        const command = typeof args.command === "string" ? args.command : ""
        if (command && isBareEnvDump(command)) {
          throw new Error(
            "secret-redactor: bare 'env'/'printenv' dumps the entire environment, including credentials. Specify a variable name, e.g. `printenv EDITOR`.",
          )
        }
      }
    },

    "tool.execute.after": async (_input, output) => {
      if (typeof output.output === "string") output.output = await sanitizeText(output.output, secrets)
      if (typeof output.title === "string") output.title = await sanitizeText(output.title, secrets)
      if (output.metadata && typeof output.metadata === "object") await redactDeep(output.metadata, secrets)
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!Array.isArray(output.system)) return
      for (let i = 0; i < output.system.length; i++) {
        const item = output.system[i]
        if (typeof item === "string") output.system[i] = await sanitizeText(item, secrets)
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages
      if (!Array.isArray(messages)) return
      for (const message of messages) {
        const parts = Array.isArray(message?.parts) ? message.parts : []
        for (const part of parts) {
          if (!part) continue

          if (part.type === "text" || part.type === "reasoning") {
            const p = part as { text?: unknown }
            if (typeof p.text === "string") p.text = await sanitizeText(p.text, secrets)
            continue
          }

          if (part.type !== "tool") continue
          const state = (part as { state?: unknown }).state as Record<string, unknown> | undefined
          if (!state || typeof state !== "object") continue

          if (state.input && typeof state.input === "object") await redactDeep(state.input, secrets)

          switch (state.status) {
            case "completed":
              if (typeof state.output === "string") state.output = await sanitizeText(state.output, secrets)
              if (typeof state.title === "string") state.title = await sanitizeText(state.title, secrets)
              if (state.metadata && typeof state.metadata === "object") await redactDeep(state.metadata, secrets)
              break
            case "error":
              if (typeof state.error === "string") state.error = await sanitizeText(state.error, secrets)
              if (state.metadata && typeof state.metadata === "object") await redactDeep(state.metadata, secrets)
              break
            case "running":
              if (typeof state.title === "string") state.title = await sanitizeText(state.title, secrets)
              if (state.metadata && typeof state.metadata === "object") await redactDeep(state.metadata, secrets)
              break
            case "pending":
              if (typeof state.raw === "string") state.raw = await sanitizeText(state.raw, secrets)
              break
          }
        }
      }
    },
  }
}
