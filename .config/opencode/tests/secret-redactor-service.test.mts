import { test, after } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { Budget, DEFAULT_LIMITS, RedactionLimitError, createScanService } from "../lib/secret-redactor/service.ts"

const FAKE = fileURLToPath(new URL("./fixtures/fake-scanner.mjs", import.meta.url))
const FAKE_GITHUB_PAT = "ghp_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0dF6hJ9"

const services: ReturnType<typeof createScanService>[] = []
function make(options: Parameters<typeof createScanService>[0] = {}, fake = true) {
  const service = createScanService({ ...(fake ? { scannerPath: FAKE } : {}), ...options })
  services.push(service)
  return service
}
const far = () => Date.now() + 10_000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

after(() => services.forEach((service) => service.close()))

test("real scanner redacts a secret and keeps UTF-16 offsets after astral characters", async () => {
  const service = make({}, false)
  const out = await service.scan(`😀 key ${FAKE_GITHUB_PAT} 😀`, "ns", far())
  assert.equal(out, "😀 key [REDACTED] 😀")
})

test("clean text round-trips and is cached", async () => {
  const service = make()
  assert.equal(await service.scan("abc", "ns", far()), "ABC")
  assert.equal(await service.scan("abc", "ns", far()), "ABC")
  assert.equal(service.stats().dispatched, 1)
  assert.equal(service.stats().cacheHits, 1)
})

test("oversized input is refused without reaching the scanner", async () => {
  const service = make()
  assert.equal(await service.scan("a".repeat(DEFAULT_LIMITS.maxInputBytes + 1), "ns", far()), undefined)
  assert.equal(service.stats().dispatched, 0)
})

test("concurrent identical requests share one scan", async () => {
  const service = make()
  const results = await Promise.all([1, 2, 3].map(() => service.scan("slow one", "ns", far())))
  assert.deepEqual(results, ["slow one", "slow one", "slow one"])
  assert.equal(service.stats().dispatched, 1)
})

test("different secret namespaces never share a result", async () => {
  const service = make()
  await Promise.all([service.scan("abc", "one", far()), service.scan("abc", "two", far())])
  assert.equal(service.stats().dispatched, 2)
})

test("cache evicts the least recently used entry and keeps the others", async () => {
  const service = make({ limits: { cacheEntries: 2 } })
  await service.scan("a", "ns", far())
  await service.scan("b", "ns", far())
  await service.scan("a", "ns", far()) // refresh a
  await service.scan("c", "ns", far()) // evicts b
  assert.equal(service.stats().cacheEntries, 2)
  const before = service.stats().dispatched
  await service.scan("a", "ns", far())
  assert.equal(service.stats().dispatched, before, "a stayed cached")
  await service.scan("b", "ns", far())
  assert.equal(service.stats().dispatched, before + 1, "b was evicted")
})

test("cache stays within its byte budget", async () => {
  const service = make({ limits: { cacheBytes: 4_000 } })
  for (let i = 0; i < 20; i++) await service.scan(`${i}`.padEnd(1_000, "x"), "ns", far())
  assert.ok(service.stats().cacheBytes <= 4_000)
})

test("a scan error withholds the text, is not cached, and does not start a cooldown", async () => {
  const service = make()
  assert.equal(await service.scan("error 1", "ns", far()), undefined)
  assert.equal(await service.scan("error 1", "ns", far()), undefined)
  assert.equal(service.stats().dispatched, 2)
  assert.equal(await service.scan("fine", "ns", far()), "FINE")
})

test("a hung scan is killed at the deadline while the parent keeps running", async () => {
  const service = make({ limits: { scanTimeoutMs: 300, cooldownMs: 200 } })
  let ticks = 0
  const ticker = setInterval(() => ticks++, 20)
  const started = Date.now()
  const out = await service.scan("hang forever", "ns", far())
  clearInterval(ticker)
  assert.equal(out, undefined)
  assert.ok(Date.now() - started < 1_500)
  assert.ok(ticks >= 5, `parent timers kept firing (${ticks})`)
  assert.equal(service.stats().failures.timeout, 1)
  assert.equal(service.stats().childRunning, false)
})

test("after a failure, work is withheld during the cooldown and resumes after it", async () => {
  const service = make({ limits: { scanTimeoutMs: 200, cooldownMs: 300 } })
  assert.equal(await service.scan("hang", "ns", far()), undefined)
  assert.equal(await service.scan("next", "ns", far()), undefined)
  assert.equal(service.stats().cooldownRejections, 1)
  await sleep(350)
  assert.equal(await service.scan("next", "ns", far()), "NEXT")
})

test("a failure withholds queued work too, and failures are never cached", async () => {
  const service = make({ limits: { scanTimeoutMs: 200, cooldownMs: 100 } })
  const [hung, queued] = await Promise.all([service.scan("hang", "ns", far()), service.scan("queued", "ns", far())])
  assert.equal(hung, undefined)
  assert.equal(queued, undefined)
  await sleep(150)
  assert.equal(await service.scan("queued", "ns", far()), "QUEUED")
})

test("a crashing scanner withholds and counts a crash", async () => {
  const service = make({ limits: { cooldownMs: 50 } })
  assert.equal(await service.scan("crash", "ns", far()), undefined)
  assert.equal(service.stats().failures.crash, 1)
})

test("a scanner that cannot start withholds", async () => {
  const service = make({ command: "/nonexistent/node-binary", limits: { cooldownMs: 50 } })
  assert.equal(await service.scan("abc", "ns", far()), undefined)
  assert.equal(service.stats().failures.spawn, 1)
})

test("malformed, mismatched and oversized replies are protocol failures", async () => {
  for (const text of ["garbage", "wrong-id", "huge"]) {
    const service = make({ limits: { cooldownMs: 50 } })
    assert.equal(await service.scan(text, "ns", far()), undefined, text)
    assert.equal(service.stats().failures.protocol, 1, text)
    assert.equal(service.stats().cacheEntries, 0, text)
  }
})

test("a caller whose deadline passes stops waiting and the abandoned scan is killed without a cooldown", async () => {
  const service = make({ limits: { scanTimeoutMs: 5_000 } })
  const started = Date.now()
  assert.equal(await service.scan("hang", "ns", Date.now() + 100), undefined)
  assert.ok(Date.now() - started < 1_000)
  assert.equal(service.stats().childRunning, false)
  assert.equal(service.stats().failures.timeout, 0)
  assert.equal(await service.scan("fine", "ns", far()), "FINE")
})

test("an already-expired deadline is withheld without scanning", async () => {
  const service = make()
  assert.equal(await service.scan("abc", "ns", Date.now() - 1), undefined)
  assert.equal(service.stats().dispatched, 0)
})

test("a full queue refuses new unique work but still serves duplicates", async () => {
  const service = make({ limits: { maxPending: 2 } })
  const first = service.scan("slow a", "ns", far())
  const second = service.scan("slow b", "ns", far())
  assert.equal(await service.scan("slow c", "ns", far()), undefined)
  assert.equal(await service.scan("slow a", "ns", far()), "slow a")
  assert.deepEqual(await Promise.all([first, second]), ["slow a", "slow b"])
})

test("the queue refuses work past its byte budget", async () => {
  const service = make({ limits: { maxPendingBytes: 100 } })
  const first = service.scan("slow " + "x".repeat(60), "ns", far())
  assert.equal(await service.scan("slow " + "y".repeat(60), "ns", far()), undefined)
  assert.ok(await first)
})

test("an idle scanner shuts itself down", async () => {
  const service = make({ limits: { idleMs: 100 } })
  await service.scan("abc", "ns", far())
  assert.equal(service.stats().childRunning, true)
  await sleep(300)
  assert.equal(service.stats().childRunning, false)
})

test("the last release stops the scanner, after running work finishes", async () => {
  const service = make()
  service.retain()
  service.retain()
  const pending = service.scan("slow x", "ns", far())
  service.release()
  service.release()
  assert.equal(await pending, "slow x")
  await sleep(50)
  assert.equal(service.stats().childRunning, false)
  assert.equal(await service.scan("again", "ns", far()), "AGAIN", "a later scan starts a fresh scanner")
})

test("close withholds outstanding work", async () => {
  const service = make()
  const pending = service.scan("slow x", "ns", far())
  service.close()
  assert.equal(await pending, undefined)
})

test("budget enforces depth, node count and total string bytes", () => {
  const limits = { ...DEFAULT_LIMITS, maxDepth: 3, maxNodes: 5, maxStringBytes: 10 }
  assert.throws(() => new Budget(limits).visit(4), RedactionLimitError)
  const nodes = new Budget(limits)
  for (let i = 0; i < 5; i++) nodes.visit(0)
  assert.throws(() => nodes.visit(0), RedactionLimitError)
  const bytes = new Budget(limits)
  bytes.chargeString(10)
  assert.throws(() => bytes.chargeString(1), RedactionLimitError)
  assert.equal(new Budget(limits, Date.now() - limits.operationTimeoutMs - 1).expired(), true)
})

test("the limit error carries no content", () => {
  assert.doesNotMatch(new RedactionLimitError().message, /ghp_|AKIA/)
})

test("budget yields to the event loop during a long traversal and stops at its deadline", async () => {
  const limits = { ...DEFAULT_LIMITS, maxNodes: 200_000 }
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const budget = new Budget(limits)
  for (let i = 0; i < 100_000; i++) await budget.tick(0)
  clearInterval(timer)
  assert.ok(ticks > 0, "timers ran during the traversal")

  const expired = new Budget(limits, Date.now() - limits.operationTimeoutMs - 1)
  await assert.rejects(expired.tick(0), RedactionLimitError)
  assert.throws(() => expired.assertActive(), RedactionLimitError)
})

test("a caller with an expired deadline gets no result, even a cached one", async () => {
  const service = make()
  assert.equal(await service.scan("abc", "ns", far()), "ABC")
  assert.equal(await service.scan("abc", "ns", Date.now() - 1), undefined)
  assert.equal(service.stats().cacheHits, 0)
})

test("a reply over the wire limit is refused before it is parsed, with or without a newline", async () => {
  const parse = JSON.parse
  let oversizedParses = 0
  JSON.parse = ((text: any, ...rest: any[]) => {
    if (typeof text === "string" && text.length > 100_000) oversizedParses++
    return (parse as any)(text, ...rest)
  }) as typeof JSON.parse
  try {
    for (const text of ["noline", "huge"]) {
      const service = make({ limits: { maxResponseBytes: 1_000, cooldownMs: 50 } })
      assert.equal(await service.scan(text, "ns", far()), undefined, text)
      assert.equal(service.stats().failures.protocol, 1, text)
      assert.equal(service.stats().childRunning, false, text)
    }
  } finally {
    JSON.parse = parse
  }
  assert.equal(oversizedParses, 0)
})

test("a heavily escaped reply within the wire limit is accepted", async () => {
  const service = make({ limits: { maxResponseBytes: 1_000 } })
  assert.equal(await service.scan("escaped", "ns", far()), "\u0001".repeat(1000))
})

test("a reply split across writes, mid-character, is reassembled", async () => {
  const service = make()
  assert.equal(await service.scan("split 😀 ok", "ns", far()), "split 😀 ok")
})

test("after a wire-limit failure the cooldown withholds work, then the scanner recovers", async () => {
  const service = make({ limits: { maxResponseBytes: 1_000, cooldownMs: 200 } })
  assert.equal(await service.scan("noline", "ns", far()), undefined)
  assert.equal(await service.scan("next", "ns", far()), undefined)
  assert.equal(service.stats().cooldownRejections, 1)
  await sleep(250)
  assert.equal(await service.scan("next", "ns", far()), "NEXT")
})

