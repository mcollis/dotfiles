import type { Plugin } from "@opencode-ai/plugin"

/**
 * Ensures an AWS SSO session is active before OpenCode starts using the
 * built-in amazon-bedrock provider. That provider reads credentials via the
 * standard AWS credential chain and refreshes short-lived credentials on its
 * own, but it has no way to run `aws sso login` when the underlying SSO
 * session itself has expired.
 *
 * This plugin checks once at startup (via the `config` hook, which OpenCode
 * calls exactly once per session) and runs `aws sso login` if credentials
 * can't be resolved, so a fresh terminal doesn't need a manual login before
 * Bedrock requests succeed.
 */
export default (async ({ $ }) => {
  const profile = process.env.AWS_PROFILE
  const profileArgs = profile ? ["--profile", profile] : []

  function dbg(msg: string) {
    console.error(`[aws-sso-auth] ${msg}`)
  }

  async function hasValidCredentials(): Promise<boolean> {
    try {
      await $`aws configure export-credentials ${profileArgs}`.quiet()
      return true
    } catch {
      return false
    }
  }

  return {
    config: async () => {
      if (await hasValidCredentials()) return
      try {
        await $`aws sso login ${profileArgs}`
      } catch (err) {
        dbg(`sso login failed: ${err}`)
      }
    },
  }
}) satisfies Plugin
