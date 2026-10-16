import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

// Bump when the scanner's rules or options change so cached results are not reused.
export const SCAN_POLICY_VERSION = "1"

export const DEFAULT_LIMITS = {
  maxInputBytes: 512 * 1024,
  maxResponseBytes: 1024 * 1024,
  scanTimeoutMs: 3_000,
  operationTimeoutMs: 10_000,
  maxPending: 8,
  maxPendingBytes: 4 * 1024 * 1024,
  cacheBytes: 8 * 1024 * 1024,
  cacheEntries: 512,
  maxDepth: 64,
  maxNodes: 20_000,
  maxStringBytes: 4 * 1024 * 1024,
  idleMs: 60_000,
  cooldownMs: 30_000,
}
export type Limits = typeof DEFAULT_LIMITS

// A traversal that never awaits something slow would starve server timers, so
// it hands control back to the event loop this often.
const YIELD_EVERY_NODES = 256

export class RedactionLimitError extends Error {
  constructor() {
    super("secret-redactor: content exceeds redaction limits and was withheld")
    this.name = "RedactionLimitError"
  }
}

// Tracks how much one redaction operation (a hook call) has traversed.
export class Budget {
  readonly deadline: number
  private readonly limits: Limits
  private nodes = 0
  private stringBytes = 0

  constructor(limits: Limits = DEFAULT_LIMITS, now: number = Date.now()) {
    this.limits = limits
    this.deadline = now + limits.operationTimeoutMs
  }

  visit(depth: number): void {
    if (depth > this.limits.maxDepth || ++this.nodes > this.limits.maxNodes) throw new RedactionLimitError()
    this.assertActive()
  }

  async tick(depth: number): Promise<void> {
    this.visit(depth)
    if (this.nodes % YIELD_EVERY_NODES !== 0) return
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.assertActive()
  }

  assertActive(): void {
    if (this.expired()) throw new RedactionLimitError()
  }

  chargeString(bytes: number): void {
    this.stringBytes += bytes
    if (this.stringBytes > this.limits.maxStringBytes) throw new RedactionLimitError()
  }

  expired(): boolean {
    return Date.now() >= this.deadline
  }
}

type FailureCategory = "timeout" | "protocol" | "spawn" | "crash"

type Waiter = { resolve: (value: string | undefined) => void; timer: ReturnType<typeof setTimeout> | undefined }

type Job = {
  id: number
  key: string
  bytes: number
  text: string | undefined
  waiters: Set<Waiter>
  timer: ReturnType<typeof setTimeout> | undefined
  startedAt: number
}

export interface ServiceOptions {
  limits?: Partial<Limits>
  command?: string
  scannerPath?: string
  // Receives content-free diagnostics only: category plus numbers.
  log?: (category: string, details: Record<string, number>) => void
}

export type ScanService = ReturnType<typeof createScanService>

export function createScanService(options: ServiceOptions = {}) {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits }
  const command = options.command ?? "node"
  const scannerPath = options.scannerPath ?? fileURLToPath(new URL("./scanner.mjs", import.meta.url))
  const log = options.log

  const pending = new Map<string, Job>()
  const queue: Job[] = []
  const cache = new Map<string, { text: string; bytes: number }>()
  let cacheBytes = 0
  let pendingBytes = 0
  let active: Job | undefined
  let child: ChildProcess | undefined
  let sequence = 0
  let refs = 0
  let cooldownUntil = 0
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let stopWhenIdle = false
  const stats = {
    dispatched: 0,
    cacheHits: 0,
    rejected: 0,
    deadlines: 0,
    cooldownRejections: 0,
    failures: { timeout: 0, protocol: 0, spawn: 0, crash: 0 },
    lastDurationMs: 0,
  }

  function keyOf(namespace: string, text: string): string {
    const hash = createHash("sha256")
    hash.update(`${SCAN_POLICY_VERSION}\0${namespace.length}:${namespace}\0`)
    hash.update(text, "utf16le")
    return hash.digest("hex")
  }

  function cacheGet(key: string): string | undefined {
    const entry = cache.get(key)
    if (!entry) return undefined
    cache.delete(key)
    cache.set(key, entry)
    return entry.text
  }

  function cacheSet(key: string, text: string): void {
    const bytes = Buffer.byteLength(text)
    if (bytes > limits.cacheBytes / 4) return
    const prior = cache.get(key)
    if (prior) {
      cacheBytes -= prior.bytes
      cache.delete(key)
    }
    cache.set(key, { text, bytes })
    cacheBytes += bytes
    while (cacheBytes > limits.cacheBytes || cache.size > limits.cacheEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cacheBytes -= cache.get(oldest)!.bytes
      cache.delete(oldest)
    }
  }

  function settle(job: Job, value: string | undefined): void {
    if (job.timer) clearTimeout(job.timer)
    job.timer = undefined
    const waiters = [...job.waiters]
    job.waiters.clear()
    for (const waiter of waiters) waiter.resolve(value)
  }

  function forget(job: Job): void {
    if (pending.get(job.key) === job) {
      pending.delete(job.key)
      pendingBytes -= job.bytes
    }
  }

  function killChild(): void {
    const current = child
    child = undefined
    if (!current) return
    try {
      current.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  function failAll(category: FailureCategory): void {
    stats.failures[category]++
    cooldownUntil = Date.now() + limits.cooldownMs
    killChild()
    const jobs = [...(active ? [active] : []), ...queue]
    active = undefined
    queue.length = 0
    for (const job of jobs) {
      forget(job)
      settle(job, undefined)
    }
    log?.("scanner-failure", { [category]: 1, withheld: jobs.length, cooldownMs: limits.cooldownMs })
  }

  function complete(job: Job, text: string | undefined): void {
    active = undefined
    forget(job)
    stats.lastDurationMs = Date.now() - job.startedAt
    if (stats.lastDurationMs > 1_000) log?.("slow-scan", { durationMs: stats.lastDurationMs, bytes: job.bytes })
    if (text !== undefined) cacheSet(job.key, text)
    settle(job, text)
    pump()
  }

  function onLine(line: string): void {
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return failAll("protocol")
    }
    const job = active
    if (!job || typeof message !== "object" || message === null || message.id !== job.id || typeof message.ok !== "boolean") {
      return failAll("protocol")
    }
    if (!message.ok) return complete(job, undefined)
    if (typeof message.text !== "string" || Buffer.byteLength(message.text) > limits.maxResponseBytes) {
      return failAll("protocol")
    }
    complete(job, message.text)
  }

  function ensureChild(): ChildProcess {
    if (child) return child
    const current = spawn(command, [scannerPath], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dirname(scannerPath),
    })
    child = current
    // Never keep the OpenCode process alive on this helper's account.
    current.unref()
    ;(current.stdin as any)?.unref?.()
    ;(current.stdout as any)?.unref?.()
    current.stdin!.on("error", () => {})
    // JSON escaping can expand a character to six bytes, so a legitimate reply
    // fits in 6x the text limit. Anything longer is refused before it is
    // buffered, decoded or parsed.
    const maxFrameBytes = 6 * limits.maxResponseBytes + 256
    let frame: Buffer[] = []
    let frameBytes = 0
    current.stdout!.on("data", (chunk: Buffer) => {
      let start = 0
      while (start < chunk.length) {
        if (child !== current) return
        const newline = chunk.indexOf(0x0a, start)
        const end = newline === -1 ? chunk.length : newline
        frameBytes += end - start
        if (frameBytes > maxFrameBytes) return failAll("protocol")
        frame.push(chunk.subarray(start, end))
        if (newline === -1) return
        const line = Buffer.concat(frame, frameBytes).toString("utf8")
        frame = []
        frameBytes = 0
        onLine(line)
        start = newline + 1
      }
    })
    const gone = (category: FailureCategory) => {
      if (child !== current) return
      child = undefined
      if (active || queue.length > 0) failAll(category)
    }
    current.on("error", () => gone("spawn"))
    current.on("exit", () => gone("crash"))
    return current
  }

  function onIdle(): void {
    clearIdle()
    if (stopWhenIdle) {
      stopWhenIdle = false
      killChild()
      return
    }
    if (!child) return
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (!active && queue.length === 0) killChild()
    }, limits.idleMs)
    idleTimer.unref?.()
  }

  function pump(): void {
    if (active) return
    const job = queue.shift()
    if (!job) return onIdle()
    clearIdle()
    active = job
    job.startedAt = Date.now()
    stats.dispatched++
    job.timer = setTimeout(() => {
      if (active === job) failAll("timeout")
    }, limits.scanTimeoutMs)
    try {
      ensureChild().stdin!.write(JSON.stringify({ id: job.id, text: job.text }) + "\n")
    } catch {
      failAll("spawn")
      return
    }
    job.text = undefined
  }

  // The caller no longer needs this job (its deadline passed). Queued work is
  // dropped; a running scan is killed because nobody can use its result. This
  // is not a scanner fault, so there is no cooldown.
  function cancel(job: Job): void {
    forget(job)
    if (active === job) {
      active = undefined
      if (job.timer) clearTimeout(job.timer)
      job.timer = undefined
      killChild()
      pump()
      return
    }
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }

  // Resolves to the scanned text, or undefined when it could not be scanned
  // (callers must treat that as "withhold").
  function scan(text: string, namespace: string, deadline: number): Promise<string | undefined> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      stats.deadlines++
      return Promise.resolve(undefined)
    }
    const bytes = Buffer.byteLength(text)
    if (bytes > limits.maxInputBytes) {
      stats.rejected++
      return Promise.resolve(undefined)
    }
    const key = keyOf(namespace, text)
    const hit = cacheGet(key)
    if (hit !== undefined) {
      stats.cacheHits++
      return Promise.resolve(hit)
    }
    let job = pending.get(key)
    if (!job) {
      if (Date.now() < cooldownUntil) {
        stats.cooldownRejections++
        return Promise.resolve(undefined)
      }
      if (pending.size >= limits.maxPending || pendingBytes + bytes > limits.maxPendingBytes) {
        stats.rejected++
        log?.("queue-full", { pending: pending.size, pendingBytes })
        return Promise.resolve(undefined)
      }
      job = { id: ++sequence, key, bytes, text, waiters: new Set(), timer: undefined, startedAt: 0 }
      pending.set(key, job)
      pendingBytes += bytes
      queue.push(job)
    }
    stopWhenIdle = false
    clearIdle()
    const target = job
    return new Promise((resolve) => {
      const waiter: Waiter = {
        timer: undefined,
        resolve: (value) => {
          if (waiter.timer) clearTimeout(waiter.timer)
          resolve(value)
        },
      }
      waiter.timer = setTimeout(() => {
        stats.deadlines++
        target.waiters.delete(waiter)
        resolve(undefined)
        if (target.waiters.size === 0) cancel(target)
      }, remaining)
      target.waiters.add(waiter)
      pump()
    })
  }

  function close(): void {
    clearIdle()
    stopWhenIdle = false
    killChild()
    const jobs = [...(active ? [active] : []), ...queue]
    active = undefined
    queue.length = 0
    for (const job of jobs) {
      forget(job)
      settle(job, undefined)
    }
  }

  return {
    scan,
    close,
    retain(): void {
      refs++
    },
    // The last holder stops the scanner once its remaining work has finished.
    release(): void {
      refs = Math.max(0, refs - 1)
      if (refs > 0) return
      if (!active && queue.length === 0) killChild()
      else stopWhenIdle = true
    },
    stats() {
      return {
        ...stats,
        failures: { ...stats.failures },
        pending: pending.size,
        cacheEntries: cache.size,
        cacheBytes,
        childRunning: child !== undefined,
      }
    },
  }
}

let shared: ScanService | undefined

export function sharedScanService(): ScanService {
  shared ??= createScanService({
    log: (category, details) => console.warn(`[secret-redactor] ${category} ${JSON.stringify(details)}`),
  })
  return shared
}

// Test seam: swap the shared service (closing the previous one).
export function setSharedScanService(service: ScanService | undefined): void {
  shared?.close()
  shared = service
}
