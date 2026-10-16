// Test double for the scanner process. Behavior is chosen by the input text.
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\n")

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    const { id, text } = JSON.parse(line)
    if (text.startsWith("hang")) for (;;);
    if (text.startsWith("crash")) process.exit(1)
    if (text.startsWith("garbage")) process.stdout.write("not json\n")
    else if (text.startsWith("wrong-id")) reply({ id: id + 1000, ok: true, text })
    else if (text.startsWith("huge")) reply({ id, ok: true, text: "x".repeat(2 * 1024 * 1024) })
    else if (text.startsWith("error")) reply({ id, ok: false })
    else if (text.startsWith("slow")) setTimeout(() => reply({ id, ok: true, text }), 300)
    else if (text.startsWith("noline")) process.stdout.write("x".repeat(2 * 1024 * 1024))
    else if (text.startsWith("escaped")) reply({ id, ok: true, text: "\u0001".repeat(1000) })
    else if (text.startsWith("split")) {
      // One reply delivered in two writes, cut in the middle of a multi-byte character.
      const bytes = Buffer.from(JSON.stringify({ id, ok: true, text }) + "\n")
      const mid = bytes.indexOf(0xf0) + 2
      process.stdout.write(bytes.subarray(0, mid))
      setTimeout(() => process.stdout.write(bytes.subarray(mid)), 30)
    }
    else reply({ id, ok: true, text: text.toUpperCase() })
  }
})
process.stdin.on("end", () => process.exit(0))
