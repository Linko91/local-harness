// Smoke test against the agent CLIs really installed here. Spends a few tokens.
// Usage: npm run build && node scripts/smoke.mjs   (also works with `bun` and `deno run -A`)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { ask, extractJson, getHarnesses } from '../dist/index.js'

/** A small solid red PNG. */
function redPng(file) {
  const size = 32
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [208, 24, 24]).flat())])
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

const runtime = globalThis.Deno ? `deno ${Deno.version.deno}` : globalThis.Bun ? `bun ${Bun.version}` : `node ${process.version}`
console.log(`runtime: ${runtime}\n`)

const harnesses = await getHarnesses()
for (const h of harnesses) {
  console.log(
    `${h.name} ${h.version} · ${h.bin}\n  login: ${h.auth.loggedIn} ${h.auth.method ?? ''} · models: ${h.models.length} (${h.modelsSource}) · default: ${h.defaultModel ?? '-'} / effort ${h.defaultEffort ?? '-'} · efforts: ${h.efforts.join(',') || '-'} · fast: ${h.fast} · images: ${h.images}`
  )
}

const dir = mkdtempSync(join(tmpdir(), 'lh-smoke-'))
const red = join(dir, 'prova.png')
redPng(red)
const plan = { claude: { model: 'haiku' }, cursor: {} }
let failed = false
try {
  for (const h of harnesses.filter((x) => x.id in plan && x.auth.loggedIn !== false)) {
    const opts = plan[h.id]
    const text = await ask(h.id, 'Reply with exactly the word: pong', { ...opts, system: 'You answer tersely.', timeoutMs: 120_000 })
    console.log(`\n${h.id} text  → ${JSON.stringify(text.text)} · model ${text.model ?? '?'} · ${text.durationMs} ms (cli ${text.cliDurationMs ?? '?'}) · applied ${JSON.stringify(text.applied)}`)
    const image = await ask(
      h.id,
      [
        { type: 'text', text: 'What colour is this image? Answer with {"colour":"..."} in English.' },
        { type: 'image', path: red, name: 'prova.png' }
      ],
      { ...opts, system: 'Reply with a JSON object only, no other text.', timeoutMs: 120_000 }
    )
    const colour = String(extractJson(image.text).colour ?? '')
    console.log(`${h.id} image → ${JSON.stringify(colour)} · ${image.durationMs} ms`)
    if (!/pong/i.test(text.text) || !/red/i.test(colour)) failed = true
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? '\nSMOKE FAILED' : '\nsmoke ok')
process.exitCode = failed ? 1 : 0
