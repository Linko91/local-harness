import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessError, createClient } from '../src/index.js'
import { type Sandbox, pngFile, sandbox } from './helpers.js'

let box: Sandbox
let images: string

beforeEach(() => {
  box = sandbox()
  images = mkdtempSync(join(tmpdir(), 'lh-img-'))
  vi.stubEnv('HOME', box.home)
  vi.stubEnv('FAKE_LOG', box.log)
  vi.stubEnv('ANTHROPIC_MODEL', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  box.cleanup()
})

const lastRun = () => {
  const runs = box.runs().filter((r) => !r.args.includes('--version') && r.args[0] !== 'models' && r.args[0] !== 'status')
  const run = runs[runs.length - 1]
  if (!run) throw new Error('no run')
  return run
}
const flagValue = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

describe('ask: Claude Code', () => {
  it('sends the prompt on stdin with a separate system prompt, no tools, clean isolation', async () => {
    const client = createClient({ path: box.bin })
    const res = await client.ask('claude', 'Hello there', { system: 'Be brief.' })
    const run = lastRun()
    expect(run.stdin).toBe('Hello there')
    expect(run.systemFile).toBe('Be brief.')
    expect(run.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    expect(flagValue(run.args, '--tools')).toBe('')
    expect(run.args).toContain('--safe-mode')
    expect(run.args).toContain('--no-session-persistence')
    expect(run.args).not.toContain('--model')
    expect(run.args).not.toContain('--effort')
    expect(res).toMatchObject({
      text: 'echo: Hello there',
      harness: 'claude',
      model: 'claude-opus-5-5',
      cliDurationMs: 1234,
      usage: { inputTokens: 20, outputTokens: 3, costUsd: 0.01 },
      sessionId: 'sess-1'
    })
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
    // The request's folder is gone afterwards.
    expect(existsSync(run.cwd)).toBe(false)
  })

  it('no system prompt: Claude keeps its own', async () => {
    const client = createClient({ path: box.bin })
    await client.ask('claude', 'x')
    expect(lastRun().args).not.toContain('--system-prompt-file')
  })

  it('with cwd: project isolation, no --safe-mode', async () => {
    const project = mkdtempSync(join(tmpdir(), 'lh-proj-'))
    const client = createClient({ path: box.bin })
    await client.ask('claude', 'x', { cwd: project })
    const run = lastRun()
    expect(run.cwd).toMatch(/lh-proj-/)
    expect(run.args).not.toContain('--safe-mode')
    await client.ask('claude', 'x', { cwd: project, isolation: 'clean' })
    expect(lastRun().args).toContain('--safe-mode')
  })

  it('passes model and effort', async () => {
    const client = createClient({ path: box.bin })
    const res = await client.ask('claude', 'x', { model: 'sonnet', effort: 'high' })
    const run = lastRun()
    expect(flagValue(run.args, '--model')).toBe('sonnet')
    expect(flagValue(run.args, '--effort')).toBe('high')
    // Sonnet has no fast mode: nothing to switch off.
    expect(run.args).not.toContain('--settings')
    expect(res.applied).toEqual({ model: 'sonnet', effort: 'high', fast: null })
  })

  it('fast mode is off by default, said explicitly where the model has it', async () => {
    const client = createClient({ path: box.bin })
    let res = await client.ask('claude', 'x', { model: 'opus' })
    expect(flagValue(lastRun().args, '--settings')).toBe('{"fastMode":false}')
    expect(res.applied.fast).toBe(false)

    res = await client.ask('claude', 'x', { model: 'opus', fast: false })
    expect(flagValue(lastRun().args, '--settings')).toBe('{"fastMode":false}')

    res = await client.ask('claude', 'x', { model: 'claude-opus-4-8', fast: true })
    expect(flagValue(lastRun().args, '--settings')).toBe('{"fastMode":true}')
    expect(res.applied.fast).toBe(true)

    // The default model may be Opus.
    await client.ask('claude', 'x', { fast: true })
    expect(flagValue(lastRun().args, '--settings')).toBe('{"fastMode":true}')
  })

  it('drops what the model lacks, or refuses it when strict', async () => {
    const client = createClient({ path: box.bin })
    const res = await client.ask('claude', 'x', { model: 'haiku', effort: 'high', fast: true })
    expect(lastRun().args).not.toContain('--effort')
    expect(lastRun().args).not.toContain('--settings')
    expect(res.applied).toEqual({ model: 'haiku', effort: null, fast: null })

    await expect(client.ask('claude', 'x', { model: 'haiku', effort: 'high', strict: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPTION'
    })
    await expect(client.ask('claude', 'x', { model: 'sonnet', fast: true, strict: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPTION'
    })
  })

  it('retries without optional flags an old version refuses', async () => {
    vi.stubEnv('FAKE_REJECT_FLAG', '--safe-mode')
    const client = createClient({ path: box.bin })
    const res = await client.ask('claude', 'x', { model: 'opus', effort: 'low' })
    const runs = box.runs().filter((r) => r.args[0] === '-p')
    expect(runs.length).toBe(2)
    expect(runs[1]?.args).not.toContain('--safe-mode')
    expect(runs[1]?.args).not.toContain('--effort')
    expect(res.text).toBe('echo: x')
    expect(res.applied).toEqual({ model: 'opus', effort: null, fast: null })
    expect(res.args).toEqual(runs[1]?.args)
  })

  it('removes Anthropic API keys and ELECTRON_RUN_AS_NODE, unless asked to keep the keys', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    await createClient({ path: box.bin }).ask('claude', 'x', { env: { FAKE_EXTRA: 'yes' } })
    expect(lastRun().env).toEqual({ ANTHROPIC_API_KEY: null, ELECTRON_RUN_AS_NODE: null, NO_COLOR: '1', FAKE_EXTRA: 'yes' })
    await createClient({ path: box.bin, keepApiKeys: true }).ask('claude', 'x')
    expect(lastRun().env.ANTHROPIC_API_KEY).toBe('sk-test')
    // Other harnesses keep the variable: it is not theirs.
    await createClient({ path: box.bin }).ask('cursor', 'x')
    expect(lastRun().env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-test', ELECTRON_RUN_AS_NODE: null })
  })

  it('sends images inside the message, in order, with their real type', async () => {
    const red = pngFile(images, 'red.png')
    const jpg = join(images, 'thumb.jpg')
    writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
    const client = createClient({ path: box.bin })
    const res = await client.ask(
      'claude',
      [
        { type: 'text', text: 'What colour?' },
        { type: 'image', path: red, name: '1-a.png' },
        { type: 'text', text: 'And this?' },
        { type: 'image', path: jpg }
      ],
      { system: 'JSON only.' }
    )
    const run = lastRun()
    expect(run.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json', '--verbose']))
    expect(flagValue(run.args, '--output-format')).toBe('stream-json')
    const msg = JSON.parse(run.stdin.trim())
    expect(msg.type).toBe('user')
    expect(msg.message.content.map((c: { type: string }) => c.type)).toEqual(['text', 'image', 'text', 'image'])
    expect(msg.message.content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: readFileSync(red).toString('base64') })
    expect(msg.message.content[3].source.media_type).toBe('image/jpeg')
    expect(res.model).toBe('claude-opus-5-5')
  })

  it('refuses unreadable images', async () => {
    const client = createClient({ path: box.bin })
    await expect(client.ask('claude', [{ type: 'image', path: join(images, 'missing.jpg') }])).rejects.toMatchObject({
      code: 'UNSUPPORTED_INPUT'
    })
    const txt = join(images, 'notes.txt')
    writeFileSync(txt, 'hello')
    await expect(client.ask('claude', [{ type: 'image', path: txt }])).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })

  it('turns CLI errors into codes', async () => {
    vi.stubEnv('FAKE_ERROR', 'Invalid API key · Please run /login')
    const err = (await createClient({ path: box.bin })
      .ask('claude', 'x')
      .catch((e: unknown) => e)) as HarnessError
    expect(err).toBeInstanceOf(HarnessError)
    expect(err).toMatchObject({ code: 'NOT_LOGGED_IN', harness: 'claude', raw: 'Invalid API key · Please run /login', exitCode: 1 })
    expect(err.message).toContain('claude auth login')
  })

  it('unwraps a fenced answer when asked', async () => {
    vi.stubEnv('FAKE_RESULT', '```\nfeat: thing\n```')
    const client = createClient({ path: box.bin })
    expect((await client.ask('claude', 'x')).text).toBe('```\nfeat: thing\n```')
    expect((await client.ask('claude', 'x', { unwrap: true })).text).toBe('feat: thing')
  })
})

describe('ask: Cursor', () => {
  it('puts the system prompt in the message, runs read-only in the request folder', async () => {
    const client = createClient({ path: box.bin })
    const res = await client.ask('cursor', 'Hello', { system: 'Be brief.' })
    const run = lastRun()
    expect(run.stdin).toBe('Be brief.\n\n---\n\nHello')
    expect(run.args.slice(0, 4)).toEqual(['-p', '--output-format', 'json', '--trust'])
    expect(run.cwd.endsWith(basename(flagValue(run.args, '--workspace') ?? '-'))).toBe(true)
    expect(flagValue(run.args, '--mode')).toBe('ask')
    expect(res).toMatchObject({ text: 'echo: Be brief.\n\n---\n\nHello', cliDurationMs: 900, usage: { inputTokens: 7, outputTokens: 2 } })
  })

  it('picks the variant for a family, effort and speed; fast off by default', async () => {
    const client = createClient({ path: box.bin })
    let res = await client.ask('cursor', 'x', { model: 'gpt-5.3-codex', effort: 'high' })
    expect(flagValue(lastRun().args, '--model')).toBe('gpt-5.3-codex-high')
    expect(res.applied).toEqual({ model: 'gpt-5.3-codex-high', effort: 'high', fast: false })

    res = await client.ask('cursor', 'x', { model: 'gpt-5.3-codex', effort: 'high', fast: true })
    expect(flagValue(lastRun().args, '--model')).toBe('gpt-5.3-codex-high-fast')

    // A variant id is used as it is.
    res = await client.ask('cursor', 'x', { model: 'claude-opus-5-thinking-high-fast' })
    expect(flagValue(lastRun().args, '--model')).toBe('claude-opus-5-thinking-high-fast')
    expect(res.applied).toEqual({ model: 'claude-opus-5-thinking-high-fast', effort: 'high', fast: true })

    // An unknown name goes through untouched.
    res = await client.ask('cursor', 'x', { model: 'brand-new-model', effort: 'high' })
    expect(flagValue(lastRun().args, '--model')).toBe('brand-new-model')
    expect(res.applied).toEqual({ model: 'brand-new-model', effort: null, fast: null })
  })

  it('gives images as files in the request folder, named as the text cites them', async () => {
    const red = pngFile(images, 'red.png')
    const client = createClient({ path: box.bin })
    await client.ask(
      'cursor',
      [
        { type: 'text', text: 'Event 1' },
        { type: 'image', path: red, name: '1-a.jpg' }
      ],
      { system: 'JSON only.', imageHint: 'Guarda le immagini.' }
    )
    const run = lastRun()
    expect(run.files.map((f) => f.name)).toEqual(['1-a.jpg'])
    expect(run.stdin).toBe('JSON only.\n\n---\n\nGuarda le immagini.\n\nEvent 1\nImages: 1-a.jpg')
  })

  it('with a project folder, images go to their own folder added with --add-dir', async () => {
    const project = mkdtempSync(join(tmpdir(), 'lh-proj-'))
    const red = pngFile(images, 'red.png')
    await createClient({ path: box.bin }).ask('cursor', [{ type: 'text', text: 'x' }, { type: 'image', path: red }], { cwd: project })
    const run = lastRun()
    expect(run.files).toEqual([])
    expect(run.extraDirs[0]?.files).toEqual(['red.png'])
  })

  it('finds cursor-agent when agent is missing', async () => {
    const only = sandbox(['cursor'])
    try {
      const { renameSync } = await import('node:fs')
      renameSync(join(only.bin, 'agent'), join(only.bin, 'cursor-agent'))
      vi.stubEnv('FAKE_LOG', only.log)
      const h = await createClient({ path: only.bin }).getHarness('cursor', { detail: 'basic' })
      expect(h.bin).toBe(join(only.bin, 'cursor-agent'))
    } finally {
      only.cleanup()
    }
  })
})

describe('ask: experimental harnesses', () => {
  it('Codex: exec with JSON events, effort through -c, images after the stdin marker', async () => {
    const red = pngFile(images, 'red.png')
    const client = createClient({ path: box.bin })
    const res = await client.ask('codex', [{ type: 'text', text: 'hi' }, { type: 'image', path: red }], {
      model: 'gpt-5.3-codex',
      effort: 'minimal',
      system: 'S'
    })
    const run = lastRun()
    expect(run.args.slice(0, 5)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json'])
    expect(flagValue(run.args, '-m')).toBe('gpt-5.3-codex')
    expect(flagValue(run.args, '-c')).toBe('model_reasoning_effort="minimal"')
    expect(run.args.slice(-2)).toEqual(['-', `--image=${red}`])
    expect(run.stdin).toBe('S\n\n---\n\nhi\nImages: red.png')
    expect(res).toMatchObject({ text: 'echo: S\n\n---\n\nhi\nImages: red.png', sessionId: 't-1', usage: { inputTokens: 20, outputTokens: 4 } })
  })

  it('Codex: errors from turn.failed', async () => {
    vi.stubEnv('FAKE_ERROR', 'You exceeded your usage limit')
    await expect(createClient({ path: box.bin }).ask('codex', 'x')).rejects.toMatchObject({ code: 'USAGE_LIMIT', harness: 'codex' })
  })

  it('Gemini: JSON output, no images', async () => {
    const client = createClient({ path: box.bin })
    const res = await client.ask('gemini', 'hi', { model: 'gemini-3-pro' })
    expect(res).toMatchObject({ text: 'echo: hi', model: 'gemini-3-pro' })
    expect(flagValue(lastRun().args, '-m')).toBe('gemini-3-pro')
    const red = pngFile(images, 'red.png')
    await expect(client.ask('gemini', [{ type: 'image', path: red }])).rejects.toMatchObject({ code: 'UNSUPPORTED_INPUT' })
  })

  it('OpenCode: plain text answer', async () => {
    const res = await createClient({ path: box.bin }).ask('opencode', 'hi', { model: 'anthropic/claude-sonnet-5' })
    expect(res.text).toBe('echo: hi')
    expect(lastRun().args).toEqual(['run', '-m', 'anthropic/claude-sonnet-5'])
  })
})

describe('ask: control', () => {
  it('NOT_INSTALLED when the CLI is missing', async () => {
    await expect(createClient({ path: '/nowhere' }).ask('claude', 'x')).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
  })

  it('UNKNOWN_HARNESS for an unknown id', async () => {
    // @ts-expect-error not a harness id
    await expect(createClient({ path: box.bin }).ask('copilot', 'x')).rejects.toMatchObject({ code: 'UNKNOWN_HARNESS' })
  })

  it('stops on abort, and does not start with an aborted signal', async () => {
    vi.stubEnv('FAKE_DELAY_MS', '5000')
    const client = createClient({ path: box.bin })
    const ctrl = new AbortController()
    const p = client.ask('claude', 'x', { signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 300)
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' })

    const before = box.runs().length
    await expect(client.ask('claude', 'x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(box.runs().length).toBe(before)
  })

  it('cancels by requestId; a new request with the same id cancels the old one', async () => {
    vi.stubEnv('FAKE_DELAY_MS', '5000')
    const client = createClient({ path: box.bin })
    const p = client.ask('claude', 'x', { requestId: 'r1' })
    await new Promise((r) => setTimeout(r, 300))
    expect(client.cancel('r1')).toBe(true)
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' })
    expect(client.cancel('r1')).toBe(false)

    const first = client.ask('claude', 'x', { requestId: 'r2' })
    await new Promise((r) => setTimeout(r, 200))
    vi.stubEnv('FAKE_DELAY_MS', '0')
    const second = client.ask('claude', 'y', { requestId: 'r2' })
    await expect(first).rejects.toMatchObject({ code: 'ABORTED' })
    expect((await second).text).toBe('echo: y')
  })

  it('times out', async () => {
    vi.stubEnv('FAKE_DELAY_MS', '5000')
    await expect(createClient({ path: box.bin }).ask('cursor', 'x', { timeoutMs: 300 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('resolveArgs shows the arguments without running the CLI', async () => {
    const client = createClient({ path: box.bin })
    const args = await client.resolveArgs('claude', 'x', { model: 'opus', effort: 'max' })
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'opus', '--effort', 'max', '--settings', '{"fastMode":false}']))
    expect(box.runs().filter((r) => r.args[0] === '-p').length).toBe(0)
  })
})
