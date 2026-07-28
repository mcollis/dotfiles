import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"

/**
 * OpenCode equivalent of Claude Code's `awsAuthRefresh`, plus dynamic model
 * discovery for Bedrock's Mantle endpoints (us-east-2).
 *
 * Mints a fresh short-term Bedrock bearer token from your AWS/SSO credentials
 * (running `aws sso login` if the session is stale) and injects it as the apiKey
 * for BOTH Mantle providers, then registers the models each one can actually use:
 *
 *   - bedrock-mantle            (@ai-sdk/openai-compatible, /v1)        chat-completions models
 *   - bedrock-mantle-responses  (@ai-sdk/openai, /openai/v1)            OpenAI Responses models (gpt-5.x)
 *
 * Mantle's /v1/models does not report per-model API support, so routing is derived
 * from the AWS compatibility matrix + live probing:
 *   - anthropic.*    -> Messages API only        (use the native amazon-bedrock provider)
 *   - openai.gpt-5*  -> Responses API only        (-> bedrock-mantle-responses)
 *   - everything else that is "available"         (-> bedrock-mantle, chat-completions)
 *
 * IMPORTANT: this file is symlinked into a dotfiles repo, so Bun resolves bare
 * `node_modules` imports from the symlink's real path (the dotfiles dir), where
 * `@aws/bedrock-token-generator` is NOT installed. We therefore load it via a
 * dynamic import of its ABSOLUTE path, which bypasses symlink-relative resolution.
 */
const MANTLE_REGION = "us-east-2"
const CHAT_BASE_URL = `https://bedrock-mantle.${MANTLE_REGION}.api.aws/v1`
const MODELS_URL = `${CHAT_BASE_URL}/models`
const TOKEN_GEN_PATH = `${homedir()}/.config/opencode/node_modules/@aws/bedrock-token-generator/dist/index.js`

// gpt-5.x are Responses-API-only; anthropic.* are Messages-only (native provider).
const RESPONSES_PREFIX = "openai.gpt-5"
const CHAT_EXCLUDE_PREFIXES = ["anthropic.", "openai.gpt-5"]

const CHAT_FALLBACK: Record<string, { name: string }> = {
  "openai.gpt-oss-120b": { name: "GPT-OSS 120B (Mantle)" },
  "mistral.mistral-large-3-675b-instruct": { name: "Mistral Large 3 (Mantle)" },
}
const RESPONSES_FALLBACK: Record<string, { name: string }> = {
  "openai.gpt-5.6-sol": { name: "GPT-5.6 Sol (Mantle)" },
}

function dbg(msg: string) {
  console.error(`[bedrock-mantle-auth] ${msg}`)
}

function prettyName(id: string): string {
  const model = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id
  return `${model} (Mantle)`
}

export default (async ({ $ }) => {
  async function mintToken(): Promise<string | undefined> {
    const profile = process.env.AWS_PROFILE
    const mod: any = await import(TOKEN_GEN_PATH)
    const getTokenProvider = mod.getTokenProvider ?? mod.default?.getTokenProvider
    const provide = getTokenProvider({ region: MANTLE_REGION, profile })
    try {
      return await provide()
    } catch {
      try {
        if (profile) await $`aws sso login --profile ${profile}`
        else await $`aws sso login`
        return await provide()
      } catch (err) {
        dbg(`mint failed: ${err}`)
        return undefined
      }
    }
  }

  async function listModelIds(token: string): Promise<string[] | undefined> {
    try {
      const res = await fetch(MODELS_URL, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { data?: Array<{ id: string; status?: string }> }
      return (body.data ?? []).filter((m) => m.status === "available").map((m) => m.id)
    } catch (err) {
      dbg(`list models failed: ${err}`)
      return undefined
    }
  }

  return {
    config: async (cfg) => {
      const chat = cfg.provider?.["bedrock-mantle"]
      const responses = cfg.provider?.["bedrock-mantle-responses"]
      if (!chat && !responses) return

      const token = await mintToken()
      if (!token) {
        if (chat) chat.models = chat.models ?? CHAT_FALLBACK
        if (responses) responses.models = responses.models ?? RESPONSES_FALLBACK
        return
      }

      if (chat) chat.options = { ...(chat.options ?? {}), apiKey: token }
      if (responses) responses.options = { ...(responses.options ?? {}), apiKey: token }

      const ids = await listModelIds(token)
      if (chat) {
        const chatIds = ids?.filter((id) => !CHAT_EXCLUDE_PREFIXES.some((p) => id.startsWith(p)))
        chat.models = chatIds?.length
          ? Object.fromEntries(chatIds.sort().map((id) => [id, { name: prettyName(id) }]))
          : chat.models ?? CHAT_FALLBACK
      }
      if (responses) {
        const respIds = ids?.filter((id) => id.startsWith(RESPONSES_PREFIX))
        responses.models = respIds?.length
          ? Object.fromEntries(respIds.sort().map((id) => [id, { name: prettyName(id) }]))
          : responses.models ?? RESPONSES_FALLBACK
      }
    },
  }
}) satisfies Plugin
