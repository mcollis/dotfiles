import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire, registerHooks } from "node:module"
import type { Effect as EffectType } from "effect"

// OpenCode supplies the plugin's Effect runtime; match that resolution under Node,
// rather than using the older, unrelated Effect beta at the config-directory root.
const effectEntry = createRequire(import.meta.resolve("@opencode/plugin/effect")).resolve("effect")
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "effect" ? effectEntry : specifier, context)
  },
})
const { Cause, Context, Effect, Exit, Schema } = await import("effect")
const { default: plugin } = await import("../plugins/plan-to-build.ts")

const APPROVE = "Switch to Build and continue"
const REMINDER = `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
/home/u/.opencode/plan

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`

interface Options {
  session?: Record<string, unknown>
  build?: Record<string, unknown> | null
  questionTool?: boolean
  switchAgent?: () => Promise<void>
  nativeQuestion?: (input: any, context: any) => EffectType.Effect<any, any, any>
}

let nextCall = 0

async function harness(options: Options = {}) {
  const calls = { switchAgent: [] as any[], forbidden: [] as string[] }
  const hooks: Record<string, (event: any) => any> = {}
  const toolHooks: Record<string, (event: any) => any> = {}
  let tool: any
  let session: any = { id: "ses_1", agent: "plan", location: { directory: "/work" }, ...options.session }
  const forbid = (name: string) => () => Effect.sync(() => {
    calls.forbidden.push(name)
  })
  const question: any = {
    id: "question",
    execute: options.nativeQuestion ?? (() => Effect.succeed({ output: { answers: [[APPROVE]] } })),
  }

  await Effect.runPromise(plugin.effect({
    tool: {
      transform: (callback: any) => Effect.sync(() => {
        callback({
          add: (definition: any) => (tool = definition),
          update: (id: string, update: any) => {
            if (id === "question" && options.questionTool !== false) update(question)
          },
        })
        return { dispose: Effect.void }
      }),
      list: () => Effect.succeed(options.questionTool === false ? [] : [question]),
      hook: (name: string, callback: any) => Effect.sync(() => {
        toolHooks[name] = (event) => Effect.runPromise(callback(event))
        return { dispose: Effect.void }
      }),
    },
    agent: {
      get: () => options.build === null
        ? Effect.fail(new Error("not found"))
        : Effect.succeed({ location: {}, data: { id: "build", mode: "primary", ...options.build } }),
    },
    session: {
      hook: (name: string, callback: any) => Effect.sync(() => {
        hooks[name] = (event) => Effect.runSync(callback(event))
        return { dispose: Effect.void }
      }),
      get: () => Effect.sync(() => session),
      switchAgent: (input: any) => Effect.gen(function* () {
        if (options.switchAgent) yield* Effect.tryPromise({ try: options.switchAgent, catch: (error) => error })
        calls.switchAgent.push(input)
      }),
      prompt: forbid("prompt"),
      synthetic: forbid("synthetic"),
      interrupt: forbid("interrupt"),
      wait: forbid("wait"),
      switchModel: forbid("switchModel"),
      update: forbid("update"),
    },
    permission: { reply: forbid("permission.reply") },
  } as any))

  const before = (action: unknown = "update the configuration", overrides: Record<string, unknown> = {}) => {
    const event: any = {
      tool: "switch_to_build",
      sessionID: "ses_1",
      agent: "plan",
      messageID: "msg_1",
      id: `call_${++nextCall}`,
      input: { action },
      ...overrides,
    }
    return { event, run: () => toolHooks["execute.before"](event) }
  }
  const after = (event: any, output: unknown, status = "completed") => {
    const result: any = { tool: event.tool, id: event.id, sessionID: event.sessionID, status, input: event.input }
    if (status === "completed") result.result = { output, content: "native question output" }
    else result.error = { message: "boom" }
    return toolHooks["execute.after"](result).then(() => result)
  }
  const flow = async (output: unknown = { answers: [[APPROVE]] }, action?: string) => {
    const { event, run } = before(action)
    await run()
    return { event, result: await after(event, output) }
  }
  const prompt = (messageID: string, delivery = "steer") => hooks.prompt({ sessionID: "ses_1", messageID, delivery })
  return {
    calls,
    hooks,
    tool: () => tool,
    before,
    after,
    flow,
    prompt,
    question: (event: any) => question.execute(event.input, {
      sessionID: event.sessionID, agent: event.agent, messageID: event.messageID, id: event.id,
      progress: () => Effect.void,
    }),
    setSession: (next: any) => (session = { ...session, ...next }),
  }
}

test("registers a direct Plan handoff tool that cannot run on its own", async () => {
  const { tool } = await harness()
  const definition = tool()
  assert.equal(definition.name, "switch_to_build")
  assert.equal(definition.options.codemode, false)
  assert.deepEqual(definition.input.required, ["action"])
  assert.equal(definition.input.additionalProperties, false)
  assert.equal(definition.input.properties.action.maxLength, 500)
  await assert.rejects(Effect.runPromise(definition.execute({ action: "x" }, {})), /execute\.before/)
})

test("rewrites the call into the native question modal with the exact wording", async () => {
  const { before } = await harness()
  const { event, run } = before("update the configuration")
  await run()
  assert.equal(event.tool, "question")
  const [{ header, question, multiple, options }] = event.input.questions
  assert.equal(event.input.questions.length, 1)
  assert.equal(header, "Switch agent")
  assert.equal(question, "This action requires Build: update the configuration\n\nSwitch to Build and continue with this action?")
  assert.equal(multiple, false)
  assert.deepEqual(options.map((option: any) => option.label), [APPROVE, "Stay in Plan"])
})

test("approval switches to Build exactly once with scoped continuation instructions", async () => {
  const { flow, calls } = await harness()
  const { result } = await flow({ answers: [[APPROVE]] }, "update the configuration")
  assert.deepEqual(calls.switchAgent, [{ sessionID: "ses_1", agent: "build" }])
  assert.match(result.result.content, /^Switched to Build\./)
  assert.match(result.result.content, /update the configuration/)
  assert.match(result.result.content, /only the requested scope/)
  assert.deepEqual(result.result.output, { answers: [[APPROVE]] })
  assert.deepEqual(calls.forbidden, [])
})

test("decline, custom, and malformed answers never switch", async () => {
  const answers = [[["Stay in Plan"]], [["do it later"]], [[APPROVE, "Stay in Plan"]], [[APPROVE], [APPROVE]], [], [[]], "yes"]
  for (const value of answers) {
    const { flow, calls } = await harness()
    const { result } = await flow({ answers: value })
    assert.match(result.result.content, /^Stayed in Plan\./)
    assert.deepEqual(calls.switchAgent, [])
  }
})

test("approval is read from structured output, never from the formatted text", async () => {
  const { flow, calls } = await harness()
  const { result } = await flow(null)
  assert.match(result.result.content, /^Stayed in Plan\./)
  assert.deepEqual(calls.switchAgent, [])
})

test("a failed question never switches and releases the pending request", async () => {
  const { before, after, calls, prompt } = await harness()
  const first = before()
  await first.run()
  await after(first.event, undefined, "error")
  assert.deepEqual(calls.switchAgent, [])
  prompt("msg_user_2")
  const second = before()
  await second.run()
  assert.equal(second.event.tool, "question")
})

class QuestionCancelled extends Schema.TaggedError<QuestionCancelled>()("QuestionTool.CancelledError", {}) {}

test("handoff dismissal returns a successful decline instead of interrupting the runner", async () => {
  const h = await harness({ nativeQuestion: () => Effect.die(new QuestionCancelled()) })
  h.prompt("msg_user_1")
  const request = h.before()
  await request.run()
  const exit = await Effect.runPromiseExit(h.question(request.event))
  assert.ok(Exit.isSuccess(exit))
  assert.deepEqual(exit.value.output, { answers: [["Stay in Plan"]] })
  assert.equal(exit.value.metadata.dismissed, true)
  const result = await h.after(request.event, exit.value.output)
  assert.match(result.result.content, /^Stayed in Plan\./)
  assert.deepEqual(h.calls.switchAgent, [])
  assert.deepEqual(h.calls.forbidden, [])
  await assert.rejects(h.before().run(), /already asked/)
  h.prompt("msg_user_2")
  await h.before().run()
})

class TestLocation extends Context.Service<TestLocation, { directory: string }>()("plan-to-build.test.Location") {}

test("native execution retains the caller's location context on success and dismissal", async () => {
  for (const dismissed of [false, true]) {
    let seen: string | undefined
    const h = await harness({
      nativeQuestion: () => Effect.gen(function* () {
        seen = (yield* TestLocation).directory
        if (dismissed) return yield* Effect.die(new QuestionCancelled())
        return { output: { answers: [[APPROVE]] } }
      }),
    })
    const request = h.before()
    await request.run()
    const result = await Effect.runPromise(h.question(request.event).pipe(
      Effect.provideService(TestLocation, { directory: "/session-location" }),
    ))
    assert.equal(seen, "/session-location")
    assert.deepEqual(result.output, { answers: [[dismissed ? "Stay in Plan" : APPROVE]] })
  }
})

test("an unrelated native question keeps its normal dismissal failure", async () => {
  const h = await harness({ nativeQuestion: () => Effect.die(new QuestionCancelled()) })
  const exit = await Effect.runPromiseExit(h.question({ id: "unrelated", sessionID: "ses_1" }))
  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.hasDies(exit.cause))
  assert.deepEqual(h.calls.switchAgent, [])
})

test("real failures, interrupts, and mixed causes are not converted to a decline", async () => {
  const failure = new Error("genuine question failure")
  const effects = [
    Effect.fail(failure),
    Effect.die(failure),
    Effect.interrupt,
    Effect.failCause(Cause.fromReasons([
      ...Cause.die(new QuestionCancelled()).reasons,
      ...Cause.fail(failure).reasons,
    ])),
  ]
  for (const native of effects) {
    const h = await harness({ nativeQuestion: () => native })
    const request = h.before()
    await request.run()
    const expected = await Effect.runPromiseExit(native)
    const actual = await Effect.runPromiseExit(h.question(request.event))
    assert.ok(Exit.isFailure(expected))
    assert.ok(Exit.isFailure(actual))
    assert.deepEqual(actual.cause.reasons.map((reason) => reason._tag), expected.cause.reasons.map((reason) => reason._tag))
    assert.deepEqual(h.calls.switchAgent, [])
    h.prompt("msg_user_2")
    await h.before().run()
  }
})

test("dismissal normalization is scoped to both the tracked call and its session", async () => {
  const h = await harness({ nativeQuestion: () => Effect.die(new QuestionCancelled()) })
  const request = h.before()
  await request.run()
  const exit = await Effect.runPromiseExit(h.question({ ...request.event, sessionID: "ses_other" }))
  assert.ok(Exit.isFailure(exit))
  assert.deepEqual(h.calls.switchAgent, [])
})

test("a failed switch is reported and leaves the session in Plan", async () => {
  const { flow, calls } = await harness({
    switchAgent: async () => {
      throw new Error("no such agent")
    },
  })
  const { result } = await flow()
  assert.match(result.result.content, /^Stayed in Plan\. The switch to Build failed: no such agent/)
  assert.deepEqual(calls.switchAgent, [])
})

test("missing prerequisites fail before any modal is shown", async () => {
  for (const options of [
    { questionTool: false },
    { build: null },
    { build: { mode: "subagent" } },
  ] as Options[]) {
    const { before, calls } = await harness(options)
    const { event, run } = before()
    await assert.rejects(run())
    assert.equal(event.tool, "switch_to_build")
    assert.deepEqual(calls.switchAgent, [])
  }
})

test("rejects non-Plan agents, child sessions, and blank or oversized actions", async () => {
  const build = await harness()
  await assert.rejects(build.before("x", { agent: "build" }).run(), /only available to the Plan agent/)
  const child = await harness({ session: { parentID: "ses_0" } })
  await assert.rejects(child.before().run(), /top-level/)
  const other = await harness({ session: { agent: "build" } })
  await assert.rejects(other.before().run(), /no longer using the Plan agent/)
  const blank = await harness()
  await assert.rejects(blank.before("   ").run(), /non-empty/)
  await assert.rejects(blank.before("x".repeat(501)).run(), /at most 500/)
  await assert.rejects(blank.before(42).run(), /non-empty/)
  for (const h of [build, child, other, blank]) assert.deepEqual(h.calls.switchAgent, [])
})

test("a second request while one is awaiting an answer is refused", async () => {
  const { before } = await harness()
  const first = before()
  await first.run()
  await assert.rejects(before().run(), /already awaiting/)
})

test("one modal per user request, a new user message allows another", async () => {
  const { before, prompt, flow } = await harness()
  prompt("msg_user_1")
  await flow({ answers: [["Stay in Plan"]] })
  await assert.rejects(before().run(), /already asked/)
  prompt("msg_user_2")
  const again = before()
  await again.run()
  assert.equal(again.event.tool, "question")
})

test("a steering prompt invalidates a pending approval, a queued one does not", async () => {
  for (const [delivery, expected] of [
    ["steer", 0],
    ["queue", 1],
  ] as const) {
    const { before, after, prompt, calls } = await harness()
    const request = before()
    await request.run()
    prompt("msg_new", delivery)
    const result = await after(request.event, { answers: [[APPROVE]] })
    assert.equal(calls.switchAgent.length, expected, delivery)
    if (expected === 0) assert.match(result.result.content, /new message arrived/)
  }
})

test("a steering prompt releases a stale request left by a dismissed modal", async () => {
  const { before, prompt } = await harness()
  await before().run()
  await assert.rejects(before().run(), /already awaiting/)
  prompt("msg_user_2")
  const next = before()
  await next.run()
  assert.equal(next.event.tool, "question")
})

test("a manual agent or location change during the modal prevents the switch", async () => {
  for (const change of [{ agent: "build" }, { location: { directory: "/elsewhere" } }]) {
    const h = await harness()
    const request = h.before()
    await request.run()
    h.setSession(change)
    const result = await h.after(request.event, { answers: [[APPROVE]] })
    assert.match(result.result.content, /^Stayed in Plan\./)
    assert.deepEqual(h.calls.switchAgent, [])
  }
})

test("unrelated tools and the user's own question calls are left alone", async () => {
  const { before, after, calls } = await harness()
  const shell = before("x", { tool: "shell", input: { command: "ls" } })
  await shell.run()
  assert.equal(shell.event.tool, "shell")
  assert.deepEqual(shell.event.input, { command: "ls" })

  const own = { tool: "question", id: "call_user_question", sessionID: "ses_1", input: {} }
  const result = await after(own, { answers: [[APPROVE]] })
  assert.equal(result.result.content, "native question output")
  assert.deepEqual(calls.switchAgent, [])
})

test("never prompts, interrupts, switches models, or replies to permissions", async () => {
  const { flow, calls } = await harness()
  await flow()
  assert.deepEqual(calls.forbidden, [])
})

test("context hook removes the tool for non-Plan agents and adds guidance for Plan", async () => {
  const { hooks } = await harness()
  const build = { agent: "build", tools: { switch_to_build: {}, read: {} }, system: [], messages: [] }
  hooks.context(build)
  assert.deepEqual(Object.keys(build.tools), ["read"])
  assert.deepEqual(build.system, [])

  const plan = { agent: "plan", tools: { switch_to_build: {} }, system: [] as any[], messages: [] }
  hooks.context(plan)
  assert.deepEqual(Object.keys(plan.tools), ["switch_to_build"])
  assert.equal(plan.system.length, 1)
  assert.match(plan.system[0].text, /switch_to_build/)
})

test("context hook rewrites only the handoff paragraph of the Plan reminder", async () => {
  const { hooks } = await harness()
  const user = { role: "user", content: [{ type: "text", text: "please implement this" }] }
  const reminder = { role: "user", content: [{ type: "text", text: REMINDER }] }
  const event = { agent: "plan", tools: {}, system: [] as any[], messages: [user, reminder] as any[] }
  hooks.context(event)

  assert.equal(event.messages[0], user)
  const text = event.messages[1].content[0].text as string
  assert.ok(!text.includes("Tell them they need to switch agents."))
  assert.match(text, /approves the `switch_to_build` modal/)
  assert.match(text, /Do not perform the action while still in Plan\./)
  assert.ok(text.includes("Do not create or update plan files unless the user explicitly asks you to"))
  assert.ok(text.includes("Do not modify any other files or ask a subagent to do so."))
  assert.equal(
    text.replace(/You remain in Plan mode until[\s\S]*?while still in Plan\./, "").trim(),
    REMINDER.replace(/You remain in Plan mode until[\s\S]*?switch agents\./, "").trim(),
  )
  assert.equal(reminder.content[0].text, REMINDER)
})

test("context hook leaves unrelated messages and non-Plan agents untouched", async () => {
  const { hooks } = await harness()
  const lookalike = { role: "user", content: [{ type: "text", text: "You remain in Plan mode until the user switches agents." }] }
  const reminder = { role: "user", content: [{ type: "text", text: REMINDER }] }
  const plan = { agent: "plan", tools: {}, system: [], messages: [lookalike] as any[] }
  hooks.context(plan)
  assert.equal(plan.messages[0], lookalike)

  const build = { agent: "build", tools: {}, system: [], messages: [reminder] as any[] }
  hooks.context(build)
  assert.equal(build.messages[0], reminder)
})
