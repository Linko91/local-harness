import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { deflateSync } from 'node:zlib'
import type { HarnessId } from '../src/types.js'

const FAKE = resolve(import.meta.dirname, 'fixtures/fake-cli.mjs')
const NAMES: Record<HarnessId, string> = { claude: 'claude', cursor: 'agent', codex: 'codex', gemini: 'gemini', opencode: 'opencode' }

export interface Sandbox {
  /** Folder with the fake executables: use it as the client's `path`. */
  bin: string
  home: string
  log: string
  runs(): Array<{
    kind: string
    args: string[]
    stdin: string
    cwd: string
    files: { name: string; size: number }[]
    extraDirs: { dir: string; files: string[] }[]
    systemFile: string | null
    env: Record<string, string | null>
  }>
  cleanup(): void
}

/** A folder of fake CLIs, a fake HOME and a log of every run. */
export function sandbox(kinds: HarnessId[] = ['claude', 'cursor', 'codex', 'gemini', 'opencode']): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'lh-test-'))
  const bin = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'runs.log')
  mkdirSync(bin)
  mkdirSync(home)
  for (const kind of kinds) {
    const file = join(bin, NAMES[kind])
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${kind} "$@"\n`)
    chmodSync(file, 0o755)
  }
  writeFileSync(log, '')
  return {
    bin,
    home,
    log,
    runs: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  }
}

/** A tiny solid-colour PNG, built by hand. */
export function pngFile(dir: string, name: string, rgb: [number, number, number] = [208, 24, 24]): string {
  const size = 8
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
  const file = join(dir, name)
  writeFileSync(file, png)
  return file
}
