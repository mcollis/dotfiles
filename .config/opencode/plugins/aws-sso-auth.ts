import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Ensures an AWS SSO session is active before OpenCode starts using the
 * built-in amazon-bedrock provider. That provider reads credentials via the
 * standard AWS credential chain and refreshes short-lived credentials on its
 * own, but it has no way to run `aws sso login` when the underlying SSO
 * session itself has expired.
 *
 * This plugin checks once per server process, when it loads, and runs
 * `aws sso login` if credentials can't be resolved, so a fresh terminal
 * doesn't need a manual login before Bedrock requests succeed.
 */

const CHECK_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 5 * 60_000

let ensured: Promise<void> | undefined

function dbg(msg: string) {
  console.error(`[aws-sso-auth] ${msg}`)
}

async function hasValidCredentials(profileArgs: string[]): Promise<boolean> {
  try {
    await run("aws", ["configure", "export-credentials", ...profileArgs], { timeout: CHECK_TIMEOUT_MS })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err
    return false
  }
}

async function ensureSession() {
  const profile = process.env.AWS_PROFILE
  const profileArgs = profile ? ["--profile", profile] : []
  try {
    if (await hasValidCredentials(profileArgs)) return
    await run("aws", ["sso", "login", ...profileArgs], { timeout: LOGIN_TIMEOUT_MS })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    dbg(`sso login failed: ${err}`)
  }
}

export default Plugin.define({
  id: "aws-sso-auth",
  async setup() {
    ensured ??= ensureSession()
    await ensured
  },
})
