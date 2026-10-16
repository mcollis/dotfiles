// Runs Secretlint in its own process so a slow or runaway scan can be killed by
// the parent instead of blocking the OpenCode server's event loop.
//
// Protocol: one JSON object per line on stdin ({ id, text }); one per line on
// stdout ({ id, ok: true, text } | { id, ok: false }). `text` in the reply is
// the input with detected secrets replaced, never the detector messages.
import { lintSource } from "@secretlint/core"
import { rules as presetRules } from "@secretlint/secretlint-rule-preset-recommend"

const REDACTED = "[REDACTED]"
const MAX_RANGES = 4096

const FILTER_COMMENTS_RULE_ID = "@secretlint/secretlint-rule-filter-comments"

// The AWS rule only scans for `AWS_SECRET_ACCESS_KEY=<value>`-style
// assignments by default; bare AKIA... access key IDs need this option.
const RULE_OPTIONS = {
  "@secretlint/secretlint-rule-aws": { enableIDScanRule: true },
}

// Excludes secretlint-rule-filter-comments: it honors a `secretlint-disable`
// marker anywhere in the scanned text, which would let untrusted message
// content suppress detection of its own secrets.
const SCAN_CONFIG = {
  rules: presetRules
    .filter((rule) => rule.meta.id !== FILTER_COMMENTS_RULE_ID)
    .map((rule) => ({ id: rule.meta.id, rule, options: RULE_OPTIONS[rule.meta.id] })),
}

function mergeRanges(ranges) {
  const sorted = ranges.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  return merged
}

async function scan(text) {
  const result = await lintSource({
    source: { filePath: "opencode-context.txt", content: text, ext: ".txt", contentType: "text" },
    options: { config: SCAN_CONFIG, noPhysicFilePath: true, maskSecrets: true },
  })
  if (result.messages.length === 0) return text
  if (result.messages.length > MAX_RANGES) throw new Error("too many detections")
  const ranges = result.messages.map((message) => message.range)
  for (const range of ranges) {
    const [start, end] = range
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
      throw new Error("invalid range")
    }
  }
  let out = ""
  let position = 0
  for (const [start, end] of mergeRanges(ranges)) {
    out += text.slice(position, start) + REDACTED
    position = end
  }
  return out + text.slice(position)
}

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

async function handle(line) {
  let request
  try {
    request = JSON.parse(line)
    if (typeof request?.id !== "number" || typeof request.text !== "string") throw new Error("bad request")
  } catch {
    process.exit(1)
  }
  try {
    reply({ id: request.id, ok: true, text: await scan(request.text) })
  } catch {
    reply({ id: request.id, ok: false })
  }
}

let buffer = ""
let queue = Promise.resolve()
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    queue = queue.then(() => handle(line))
  }
})
process.stdin.on("end", () => process.exit(0))
