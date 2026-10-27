import { Plugin, type Model } from "@opencode/plugin/effect"
import { Message, ToolFailure } from "@opencode/ai"
import { Cause, Effect, Exit, Predicate } from "effect"

const TOOL = "switch_to_build"
const QUESTION = "question"
const PLAN = "plan"
const BUILD = "build"
const APPROVE = "Switch to Build and continue"
const DECLINE = "Stay in Plan"
const MAX_ACTION = 500

const GUIDANCE = `When the user explicitly requests an action that requires Build, call \`${TOOL}\` with a concise description of that action. Call it alone, without performing the action first. Do not offer a switch merely because a plan is complete. Resolve substantive ambiguities before offering the switch.`

const HANDOFF_OLD =
  "You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents."
const HANDOFF_NEW = `You remain in Plan mode until the user switches agents manually or approves the \`${TOOL}\` modal. When the user explicitly requests an action requiring Build, use \`${TOOL}\` to request that approval. Do not perform the action while still in Plan.`

const STAYED = "Stayed in Plan. Do not perform the action or ask again for this request."

interface Handoff {
  readonly sessionID: string
  readonly messageID: string
  readonly action: string
  location?: string
  invalidated: boolean
}

interface SessionState {
  lastPrompt?: string
  attempted?: string
  pending?: Handoff
  model?: Model.Ref
  blockedMessage?: string
  nextSelection?: { agent: string; model: Model.Ref }
}

function parseAction(input: unknown): string {
  const raw = (input as { action?: unknown } | undefined)?.action
  const action = typeof raw === "string" ? raw.trim() : ""
  if (!action) throw new Error("`action` must be a non-empty description of the requested action.")
  if (action.length > MAX_ACTION) throw new Error(`\`action\` must be at most ${MAX_ACTION} characters.`)
  return action
}

function locationKey(session: { location: { directory: string; workspaceID?: string } }) {
  return `${session.location.directory}|${session.location.workspaceID ?? ""}`
}

// OpenCode reports an unspecified variant as "default", so the two are the same selection.
const variantOf = (model: Model.Ref) => model.variant ?? "default"

function sameModel(actual: Model.Ref | undefined, expected: Model.Ref): boolean {
  return actual?.providerID === expected.providerID && actual.id === expected.id && variantOf(actual) === variantOf(expected)
}

function isApproved(output: unknown): boolean {
  const answers = (output as { answers?: unknown } | undefined)?.answers
  if (!Array.isArray(answers) || answers.length !== 1) return false
  const [first] = answers
  return Array.isArray(first) && first.length === 1 && first[0] === APPROVE
}

function rewriteReminder(message: any): string | undefined {
  if (message?.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) return undefined
  const part = message.content[0]
  if (part?.type !== "text" || typeof part.text !== "string") return undefined
  if (!part.text.startsWith("<system-reminder>") || !part.text.includes("You are in Plan mode.")) return undefined
  if (!part.text.includes(HANDOFF_OLD)) return undefined
  return part.text.replace(HANDOFF_OLD, HANDOFF_NEW)
}

export default Plugin.define({
  id: "plan-to-build",
  effect: Effect.fn("plan-to-build.setup")(function* (ctx) {
    const sessions = new Map<string, SessionState>()
    const calls = new Map<string, Handoff>()
    const stateOf = (id: string) => {
      let state = sessions.get(id)
      if (!state) sessions.set(id, (state = {}))
      return state
    }
    const release = (callID: string) => {
      const handoff = calls.get(callID)
      if (!handoff) return undefined
      calls.delete(callID)
      const state = sessions.get(handoff.sessionID)
      if (state?.pending === handoff) state.pending = undefined
      return handoff
    }

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL,
        description:
          "Ask the user, through the native question modal, to switch this session from Plan to Build so a requested action can be performed. Plan agent only.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              minLength: 1,
              maxLength: MAX_ACTION,
              description: "Concise description of the action that requires Build",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute() {
          return Effect.fail(new ToolFailure({ message: `${TOOL} is handled by the plugin's execute.before hook and must not run directly.` }))
        },
      })

      editor.update(QUESTION, (question) => {
        const nativeExecute = question.execute
        question.execute = (input, context) => nativeExecute(input, context).pipe(
          // Native dismissal is a defect, not a normal tool failure. Recover only this
          // plugin's modal, in the caller's Effect context so form routing stays intact.
          Effect.catchCause((cause) => {
            const handoff = calls.get(context.id)
            const reason = cause.reasons[0]
            if (
              handoff?.sessionID !== context.sessionID ||
              cause.reasons.length !== 1 ||
              !reason ||
              !Cause.isDieReason(reason) ||
              !Predicate.isTagged(reason.defect, "QuestionTool.CancelledError")
            ) return Effect.failCause(cause)
            const output = { answers: [[DECLINE]] }
            return Effect.succeed({ output, content: STAYED, metadata: { ...output, dismissed: true } })
          }),
          Effect.onExit((exit) => Effect.sync(() => {
            if (Exit.isFailure(exit)) release(context.id)
          })),
        )
      })
    })

    // The question must run in the session's own tool context: a nested call from here lacks the
    // Location the UI needs to display the form, so the modal would never appear.
    yield* ctx.tool.hook("execute.before", Effect.fnUntraced(function* (event) {
      const existing = sessions.get(event.sessionID)
      if (existing?.blockedMessage === event.messageID || existing?.nextSelection)
        return yield* new ToolFailure({ message: "The Plan-to-Build handoff requires a verified new model request. Do not perform the action in this request." })
      if (event.tool !== TOOL) return
      const action = yield* Effect.try({
        try: () => parseAction(event.input),
        catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
      })
      if (event.agent !== PLAN) return yield* new ToolFailure({ message: `${TOOL} is only available to the Plan agent.` })

      const state = stateOf(event.sessionID)
      if (state.pending) return yield* new ToolFailure({ message: "A switch request is already awaiting the user's answer." })
      const key = state.lastPrompt
      if (key !== undefined && state.attempted === key)
        return yield* new ToolFailure({ message:
          "The user was already asked about switching for this request. Stay in Plan until they send a new message.",
        })
      const handoff: Handoff = { sessionID: event.sessionID, messageID: event.messageID, action, invalidated: false }
      state.pending = handoff
      calls.set(event.id, handoff)
      if (key !== undefined) state.attempted = key

      yield* Effect.gen(function* () {
        const session = yield* ctx.session.get({ sessionID: event.sessionID })
        if (session.parentID !== undefined) return yield* new ToolFailure({ message: `${TOOL} is only available in top-level sessions.` })
        if (session.agent !== undefined && session.agent !== PLAN)
          return yield* new ToolFailure({ message: "This session is no longer using the Plan agent." })
        handoff.location = locationKey(session)

        const build = (yield* ctx.agent.get({ agentID: BUILD, location: { directory: session.location.directory } })
          .pipe(Effect.catch(() => Effect.succeed(undefined))))?.data
        if (!build || build.mode === "subagent") return yield* new ToolFailure({ message: "The Build agent is not available." })

        if (!(yield* ctx.tool.list()).some((tool) => tool.id === QUESTION))
          return yield* new ToolFailure({ message: "The native question tool is not available." })
      }).pipe(
        Effect.mapError((error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) })),
        Effect.onExit((exit) => Effect.sync(() => {
          if (Exit.isFailure(exit)) release(event.id)
        })),
      )

      event.tool = QUESTION
      event.input = {
        questions: [
          {
            header: "Switch agent",
            question: `This action requires Build: ${action}\n\nSwitch to Build and continue with this action?`,
            multiple: false,
            options: [
              { label: APPROVE, description: "Switch this session to Build and perform the requested action." },
              { label: DECLINE, description: "Keep planning without performing the action." },
            ],
          },
        ],
      }
    }))

    yield* ctx.tool.hook("execute.after", Effect.fnUntraced(function* (event) {
      if (event.tool !== QUESTION) return
      const handoff = calls.get(event.id)
      if (!handoff || handoff.sessionID !== event.sessionID) return
      if (event.status !== "completed") {
        release(event.id)
        return
      }

      const respond = (content: string) => {
        event.result = { ...event.result, content }
      }
      if (!isApproved(event.result.output)) {
        release(event.id)
        return respond(STAYED)
      }
      if (handoff.invalidated) {
        release(event.id)
        return respond("Stayed in Plan. A new message arrived while the switch was pending, so the approval was not applied.")
      }

      const state = stateOf(handoff.sessionID)
      let previous: Model.Ref | undefined
      let target: Model.Ref | undefined
      let switching = false
      yield* Effect.gen(function* () {
        const current = yield* ctx.session.get({ sessionID: handoff.sessionID })
        if (current.parentID !== undefined || (current.agent !== undefined && current.agent !== PLAN))
          return respond("Approval not applied. The session's agent changed while the switch was pending.")
        if (locationKey(current) !== handoff.location)
          return respond("Approval not applied. The session's location changed while the switch was pending.")

        const location = { directory: current.location.directory }
        const build = (yield* ctx.agent.get({ agentID: BUILD, location })).data
        if (build.mode === "subagent") return yield* new ToolFailure({ message: "The Build agent is not available." })
        const fallback = build.model ? undefined : (yield* ctx.model.default({ location })).data
        target = build.model ?? (fallback && { providerID: fallback.providerID, id: fallback.id })
        if (!target) return yield* new ToolFailure({ message: "No default Build model is available." })
        const available = (yield* ctx.model.list({ location })).data.find((model) =>
          model.enabled && model.providerID === target!.providerID && model.id === target!.id)
        if (!available || (target.variant !== undefined && !available.variants.some((variant) => variant.id === target!.variant)))
          return yield* new ToolFailure({ message: "The configured Build model or variant is unavailable." })
        previous = current.model ?? state.model
        if (!previous) return yield* new ToolFailure({ message: "The current Plan model is unknown; the switch was not applied." })
        if (handoff.invalidated) return respond("Stayed in Plan. A new message arrived, so the approval was not applied.")

        // Selection changes affect the next provider step, not the request executing this tool.
        state.blockedMessage = handoff.messageID
        state.nextSelection = { agent: PLAN, model: previous }
        switching = true
        yield* ctx.session.switchModel({ sessionID: handoff.sessionID, model: target })
        const selected = yield* ctx.session.get({ sessionID: handoff.sessionID })
        if (handoff.invalidated || locationKey(selected) !== handoff.location ||
          (selected.agent !== undefined && selected.agent !== PLAN) || !sameModel(selected.model, target))
          return yield* new ToolFailure({ message: "The model switch was not verified or the approval became stale." })
        yield* ctx.session.switchAgent({ sessionID: handoff.sessionID, agent: BUILD })
        const switched = yield* ctx.session.get({ sessionID: handoff.sessionID })
        if (handoff.invalidated || locationKey(switched) !== handoff.location ||
          switched.agent !== BUILD || !sameModel(switched.model, target))
          return yield* new ToolFailure({ message: "The Build agent/model selection was not verified or the approval became stale." })
        state.nextSelection = { agent: BUILD, model: target }
        respond(
          `Switched to Build. Model: ${target.providerID}/${target.id}${target.variant ? `#${target.variant}` : ""}. The current Plan request must not execute further tools. Continue only in the next verified Build request with the approved action: ${handoff.action}. Perform only the requested scope and retain all existing permission requirements.`,
        )
      }).pipe(
        Effect.catch((error) => Effect.gen(function* () {
          let recovery = "The switch was not applied."
          if (switching && previous) {
            const restore = previous
            recovery = yield* Effect.gen(function* () {
              const current = yield* ctx.session.get({ sessionID: handoff.sessionID })
              if (locationKey(current) !== handoff.location ||
                (current.agent !== undefined && current.agent !== PLAN && current.agent !== BUILD) ||
                (!sameModel(current.model, restore) && !sameModel(current.model, target!)))
                return yield* new ToolFailure({ message: "The session changed; automatic restoration was not applied." })
              yield* ctx.session.switchAgent({ sessionID: handoff.sessionID, agent: PLAN })
              yield* ctx.session.switchModel({ sessionID: handoff.sessionID, model: restore })
              const restored = yield* ctx.session.get({ sessionID: handoff.sessionID })
              if (restored.agent !== PLAN || !sameModel(restored.model, restore) || locationKey(restored) !== handoff.location)
                return yield* new ToolFailure({ message: "Restoration was not verified." })
              return "Restored Plan and the previous model."
            }).pipe(Effect.catch((failure) => Effect.succeed(
              `Restoration failed: ${failure instanceof Error ? failure.message : String(failure)}. Execution is blocked until Plan and the previous model are restored.`,
            )))
          }
          respond(`Switch to Build failed: ${error instanceof Error ? error.message : String(error)}. ${recovery} Do not perform the action or ask again for this request.`)
        })),
        Effect.ensuring(Effect.sync(() => release(event.id))),
      )
    }))

    yield* ctx.session.hook("prompt", (event) => Effect.sync(() => {
      const state = stateOf(event.sessionID)
      state.lastPrompt = event.messageID
      if (event.delivery !== "steer" || !state.pending) return
      state.pending.invalidated = true
      state.pending = undefined
    }))

    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      const state = stateOf(event.sessionID)
      if (state.nextSelection) {
        const expected = state.nextSelection
        if (event.agent !== expected.agent || !sameModel(event.model, expected.model))
          throw new Error("Plan-to-Build selection mismatch. Execution blocked before model dispatch.")
        state.nextSelection = undefined
      }
      state.model = event.model
      if (event.agent !== PLAN) {
        delete event.tools[TOOL]
        return
      }
      event.system.push({ type: "text", text: GUIDANCE })
      event.messages.forEach((message, index) => {
        const text = rewriteReminder(message)
        if (text !== undefined) event.messages[index] = Message.user(text)
      })
    }))
  }),
})
