import { Plugin } from "@opencode/plugin";
import { createHash } from "node:crypto";
import {
  Budget,
  DEFAULT_LIMITS,
  RedactionLimitError,
  sharedScanService,
} from "../lib/secret-redactor/service.ts";

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
//    It runs in a separate process (lib/secret-redactor) with a hard deadline,
//    so a slow scan cannot stall the OpenCode server.
//
// Fail-closed: if scanning fails, times out or is refused (oversized input, full
// queue), or a captured secret value still appears verbatim in the result, the
// text is withheld rather than forwarded raw. A request that exceeds the
// traversal limits is rejected outright rather than partially redacted.
//
// Known gap: this stops secrets from reaching the model. It does not remove
// raw shell output already written to opencode's local session database by
// the time these hooks run — only from what leaves this process afterward.

const REDACTED = "[REDACTED]";
const WITHHELD =
  "[secret-redactor: output withheld — could not verify it was free of secrets]";

const SENSITIVE_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|_KEY$|_PWD$)/i;
const MIN_SECRET_LENGTH = 6;

function captureEnvSecrets(): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SENSITIVE_ENV_NAME.test(name)) continue;
    values.add(value);
  }
  // Longest first: if one captured value is a prefix of another, redacting
  // the longer one first avoids leaving a mangled remainder of the shorter.
  return Array.from(values).sort((a, b) => b.length - a.length);
}

function redactExactValues(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

// Cache and in-flight scans are keyed by the captured secret set as well as the
// text, so a later plugin load never reuses a result computed before a value
// became a known secret.
const namespaces = new WeakMap<string[], string>();

function namespaceFor(secrets: string[]): string {
  let namespace = namespaces.get(secrets);
  if (namespace === undefined) {
    const hash = createHash("sha256");
    for (const secret of secrets) hash.update(`${secret.length}:${secret}\0`);
    namespaces.set(secrets, (namespace = hash.digest("hex")));
  }
  return namespace;
}

function withinInputLimit(text: string): boolean {
  // UTF-16 length is a lower bound on UTF-8 bytes, so the cheap check goes first.
  return (
    text.length <= DEFAULT_LIMITS.maxInputBytes &&
    Buffer.byteLength(text) <= DEFAULT_LIMITS.maxInputBytes
  );
}

async function sanitizeText(
  text: string,
  secrets: string[],
  budget: Budget = new Budget(),
): Promise<string> {
  if (!text) return text;
  if (!withinInputLimit(text)) return WITHHELD;
  budget.assertActive();
  budget.chargeString(Buffer.byteLength(text));

  const afterExact = redactExactValues(text, secrets);
  if (!withinInputLimit(afterExact)) return WITHHELD;
  const afterScan = await sharedScanService().scan(
    afterExact,
    namespaceFor(secrets),
    budget.deadline,
  );
  budget.assertActive();
  if (afterScan === undefined) return WITHHELD;
  // Fail-closed verification: a captured env secret should never survive both
  // passes. If one does (e.g. it appeared only after scanning altered offsets),
  // withhold rather than forward it.
  return secrets.some((secret) => secret && afterScan.includes(secret))
    ? WITHHELD
    : afterScan;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Returns a redacted copy of strings, arrays and plain objects; anything else
// (class instances, binary data) passes through untouched. A cyclic structure
// cannot be copied, so it is withheld rather than forwarded unscanned. Throws
// RedactionLimitError when the value is deeper or larger than the budget allows.
async function redactValue(
  value: unknown,
  secrets: string[],
  budget: Budget = new Budget(),
  depth = 0,
  ancestors = new Set<object>(),
): Promise<unknown> {
  await budget.tick(depth);
  if (typeof value === "string") return sanitizeText(value, secrets, budget);
  if (!value || typeof value !== "object") return value;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value;
  if (ancestors.has(value)) return WITHHELD;

  ancestors.add(value);
  try {
    if (isArray) {
      const out: unknown[] = [];
      for (const item of value)
        out.push(
          await redactValue(item, secrets, budget, depth + 1, ancestors),
        );
      return out;
    }
    const out: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      out[key] = await redactValue(source[key], secrets, budget, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
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
];
const EXEMPT_PATH_SUFFIXES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".pub",
];

function looksSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (EXEMPT_PATH_SUFFIXES.some((suffix) => lower.endsWith(suffix)))
    return false;
  return SENSITIVE_PATH_SNIPPETS.some((snippet) => lower.includes(snippet));
}

// Catches the literal incident from this session: `printenv` or `env` with no
// variable name dumps everything. This is necessarily a static, best-effort
// check — it can't see shell expansion, so `printenv $UNSET_VAR` (which is how
// the original leak happened) still runs. Post-execution redaction in
// tool.execute.after and the history transform is what actually catches that
// case; this guard just stops the obviously-bare form before it runs at all.
function isBareEnvDump(command: string): boolean {
  for (const segment of command.split(/[;&|]+|\n/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const head = (tokens[0] ?? "").replace(/^.*\//, "");
    if (head !== "env" && head !== "printenv") continue;
    const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
    if (args.length === 0) return true;
  }
  return false;
}

// Encoded images and PDFs are binary: rewriting or withholding one corrupts it
// and the provider then rejects the request, while a text scanner cannot see
// inside base64 anyway. So the payload field of the two shapes OpenCode itself
// produces for them is passed through untouched. The exemption is structural
// and applies only at the boundaries that carry those shapes; a string that
// merely looks like an image gets none, and every other field is scanned.
const MEDIA_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

// A tool-content file part: { type: "file", uri: "data:<mime>;base64,…", mime, name? }.
function isInlineMediaFilePart(part: unknown): part is { type: "file"; uri: string; mime: string } {
  const candidate = part as Record<string, unknown> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.type === "file" &&
    typeof candidate.mime === "string" &&
    MEDIA_MIMES.has(candidate.mime) &&
    typeof candidate.uri === "string" &&
    candidate.uri.startsWith(`data:${candidate.mime};base64,`)
  )
}

// The `read` tool's structured output: { type: "file", encoding: "base64", mime, content, … }.
function isBase64MediaReadOutput(output: unknown): output is { type: "file"; encoding: "base64"; mime: string; content: string } {
  const candidate = output as Record<string, unknown> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    isPlainObject(candidate) &&
    candidate.type === "file" &&
    candidate.encoding === "base64" &&
    typeof candidate.mime === "string" &&
    MEDIA_MIMES.has(candidate.mime) &&
    typeof candidate.content === "string"
  )
}

// Redacts everything except `field`, which is carried over as is.
async function redactAllBut<T extends Record<string, any>>(
  value: T,
  field: keyof T & string,
  secrets: string[],
  budget: Budget,
  depth: number,
): Promise<T> {
  const { [field]: preserved, ...rest } = value
  const redacted = (await redactValue(rest, secrets, budget, depth)) as Record<string, unknown>
  return { ...redacted, [field]: preserved } as T
}

function redactReadOutput(output: unknown, secrets: string[], budget: Budget): Promise<unknown> {
  return isBase64MediaReadOutput(output)
    ? redactAllBut(output, "content", secrets, budget, 0)
    : redactValue(output, secrets, budget)
}

// The shapes below are the parts of OpenCode's request types this plugin edits.
// They are loose on purpose: parts are mutated in place and a field that is
// absent or of another type is simply skipped.
type Part = Record<string, any>;
interface RequestEvent {
  system: Part[];
  messages: { content: Part[] }[];
}

async function redactMessagePart(
  part: Part,
  secrets: string[],
  budget: Budget,
  commits: Array<() => void>,
): Promise<void> {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "compaction":
      if (typeof part.text === "string") {
        const text = await sanitizeText(part.text, secrets, budget)
        commits.push(() => {
          part.text = text
        })
      }
      break
    case "tool-call": {
      const input = await redactValue(part.input, secrets, budget)
      commits.push(() => {
        part.input = input
      })
      break
    }
    case "tool-result":
      if (part.result && typeof part.result === "object") {
        const result = part.result
        const value = await redactToolResultValue(part.name, result, secrets, budget)
        commits.push(() => {
          part.result = { ...result, value }
        })
      }
      break
  }
}

async function redactToolResultValue(tool: unknown, result: Part, secrets: string[], budget: Budget): Promise<unknown> {
  if (result.type === "content" && Array.isArray(result.value)) return redactToolContent(result.value, secrets, budget)
  if (tool === "read") return redactReadOutput(result.value, secrets, budget)
  return redactValue(result.value, secrets, budget)
}

// Redacted copies are built first and written back only once the whole request
// is done, so a limit error never leaves a request half-redacted.
async function redactRequest(event: RequestEvent, secrets: string[]): Promise<void> {
  const budget = new Budget()
  const commits: Array<() => void> = []
  for (const part of event.system ?? []) {
    await budget.tick(0)
    if (typeof part.text === "string") {
      const text = await sanitizeText(part.text, secrets, budget)
      commits.push(() => {
        part.text = text
      })
    }
  }
  for (const message of event.messages ?? []) {
    await budget.tick(0)
    for (const part of message.content ?? []) {
      await budget.tick(1)
      await redactMessagePart(part, secrets, budget, commits)
    }
  }
  budget.assertActive()
  for (const commit of commits) commit()
}

async function redactContentPart(part: unknown, secrets: string[], budget: Budget): Promise<unknown> {
  const candidate = part as Record<string, unknown> | null
  if (candidate && typeof candidate === "object" && candidate.type === "text" && typeof candidate.text === "string") {
    await budget.tick(1)
    return { ...candidate, text: await sanitizeText(candidate.text, secrets, budget) }
  }
  if (isInlineMediaFilePart(part)) {
    await budget.tick(1)
    return redactAllBut(part, "uri", secrets, budget, 2)
  }
  return redactValue(part, secrets, budget, 1)
}

async function redactToolContent(content: unknown, secrets: string[], budget: Budget): Promise<unknown> {
  if (typeof content === "string") return sanitizeText(content, secrets, budget)
  if (!Array.isArray(content)) return content
  const out: unknown[] = []
  for (const part of content) out.push(await redactContentPart(part, secrets, budget))
  return out
}

// A tool result too large or deep to scan is replaced, not forwarded.
function withheldToolResult(result: any): any {
  const { content, output } = result
  const withheld = { ...result }
  if (content !== undefined) {
    withheld.content = Array.isArray(content) ? [{ type: "text", text: WITHHELD }] : WITHHELD
  }
  if (output !== undefined) withheld.output = WITHHELD
  delete withheld.metadata
  return withheld
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
  return sanitizeText(text, sharedSecrets, new Budget()).catch((error) => {
    if (error instanceof RedactionLimitError) return WITHHELD
    throw error
  })
}

export default Plugin.define({
  id: "secret-redactor",
  async setup(ctx) {
    const secrets = captureEnvSecrets()
    const scanner = sharedScanService()
    scanner.retain()

    await ctx.session.hook("prompt", async (event) => {
      const original = event.prompt.text
      if (typeof original !== "string") return
      const redacted = await sanitizeText(original, secrets, new Budget())
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
      const budget = new Budget()
      if (event.status === "completed") {
        const { content, output, metadata } = event.result
        try {
          const next = {
            ...event.result,
            ...(content !== undefined && { content: (await redactToolContent(content, secrets, budget)) as typeof content }),
            ...(output !== undefined && {
              output: event.tool === "read" ? await redactReadOutput(output, secrets, budget) : await redactValue(output, secrets, budget),
            }),
            ...(metadata !== undefined && { metadata: (await redactValue(metadata, secrets, budget)) as typeof metadata }),
          }
          budget.assertActive()
          event.result = next
        } catch (error) {
          if (!(error instanceof RedactionLimitError)) throw error
          event.result = withheldToolResult(event.result)
        }
        return
      }
      // A failure's message is also resent as a tool result, which the context
      // hooks above redact, so this is a best-effort first pass.
      const error = event.error as { message: string; metadata?: unknown }
      let message = WITHHELD
      try {
        message = await sanitizeText(error.message, secrets, budget)
      } catch (limit) {
        if (!(limit instanceof RedactionLimitError)) throw limit
      }
      try {
        error.message = message
        if ("metadata" in error) error.metadata = undefined
      } catch {
        // Read-only error object; the context hooks still cover it.
      }
    })

    return () => scanner.release()
  },
})
