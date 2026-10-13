import { test } from "node:test"
import assert from "node:assert/strict"
import plugin from "../plugins/notify.ts"

async function guard() {
  let before!: (event: any) => void
  await plugin.setup({
    tool: { hook: async (_name: string, callback: any) => ((before = callback), { dispose: async () => {} }) },
  } as any)
  return (command: string) => before({ tool: "shell", input: { command } })
}

// Built by concatenation so this file never contains the blocked phrase literally.
const TRAILER = "Co-" + "Authored-" + "By"

test("blocks an inline trailer", async () => {
  const run = await guard()
  assert.throws(() => run(`git commit -m "fix\n\n${TRAILER}: Bot <bot@example.com>"`), /footer/)
})

test("blocks a heredoc message, in any letter case", async () => {
  const run = await guard()
  assert.throws(() => run(`git commit -F - <<'EOF'\nsubject\n\n${TRAILER.toLowerCase()}: Bot <b@e.com>\nEOF`), /footer/)
})

test("allows an ordinary commit and unrelated commands", async () => {
  const run = await guard()
  assert.doesNotThrow(() => run(`git commit -m "fix the thing"`))
  assert.doesNotThrow(() => run(`echo ${TRAILER}`))
  assert.doesNotThrow(() => run(`git log --grep=commit`))
})
