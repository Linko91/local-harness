import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessError, createClient } from '../src/index.js'
import { type Sandbox, sandbox } from './helpers.js'

let box: Sandbox

beforeEach(() => {
  box = sandbox()
  vi.stubEnv('HOME', box.home)
  vi.stubEnv('FAKE_LOG', box.log)
  vi.stubEnv('ANTHROPIC_MODEL', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('CODEX_HOME', '')
  vi.stubEnv('GEMINI_API_KEY', '')
  vi.stubEnv('GOOGLE_API_KEY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  box.cleanup()
})

describe('getHarnesses', () => {
  it('finds every installed CLI with version, login, models and capabilities', async () => {
    const client = createClient({ path: box.bin })
    const list = await client.getHarnesses()
    expect(list.map((h) => h.id)).toEqual(['claude', 'cursor', 'codex', 'gemini', 'opencode'])

    const claude = list[0]
    expect(claude).toMatchObject({
      name: 'Claude Code',
      installed: true,
      bin: join(box.bin, 'claude'),
      version: '2.1.303',
      versionText: '2.1.303 (Claude Code)',
      verified: true,
      images: true,
      auth: { loggedIn: true, method: 'claude.ai', loginCommand: 'claude auth login' },
      defaultModel: null,
      defaultEffort: null,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      fast: true,
      customModels: true,
      modelsSource: 'catalog'
    })
    // Only aliases: Claude Code does not list versions.
    expect(claude?.models.map((m) => m.id)).toEqual(['', 'opus', 'sonnet', 'haiku', 'fable'])
    expect(claude?.models.find((m) => m.id === 'haiku')).toMatchObject({ efforts: [], fast: false })

    const cursor = list[1]
    expect(cursor).toMatchObject({ name: 'Cursor Agent', bin: join(box.bin, 'agent'), auth: { loggedIn: true }, modelsSource: 'cli', fast: true })
    expect(cursor?.models.length).toBeGreaterThan(20)

    expect(list[2]).toMatchObject({ version: '0.98.0', verified: false, auth: { loggedIn: true, method: 'chatgpt' }, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] })
    expect(list[3]).toMatchObject({ installed: true, images: false, auth: { loggedIn: null, loginCommand: 'gemini' } })
    expect(list[4]?.models.map((m) => m.id)).toEqual(['', 'anthropic/claude-sonnet-5', 'openai/gpt-5.3'])
    expect(list[4]?.auth.loggedIn).toBe(true)
  })

  it('leaves out missing CLIs unless includeMissing', async () => {
    const only = sandbox(['claude'])
    try {
      const client = createClient({ path: only.bin })
      expect((await client.getHarnesses()).map((h) => h.id)).toEqual(['claude'])
      const all = await client.getHarnesses({ includeMissing: true })
      expect(all.map((h) => [h.id, h.installed])).toEqual([
        ['claude', true],
        ['cursor', false],
        ['codex', false],
        ['gemini', false],
        ['opencode', false]
      ])
      // Not installed, but the built-in catalog is still there (for a settings screen).
      expect(all[1]).toMatchObject({ bin: null, version: null, auth: { loggedIn: null, loginCommand: 'agent login' } })
      expect(all[1]?.models[0]?.id).toBe('')
    } finally {
      only.cleanup()
    }
  })

  it('basic detail runs only --version', async () => {
    const client = createClient({ path: box.bin, harnesses: ['claude', 'cursor'] })
    const list = await client.getHarnesses({ detail: 'basic' })
    expect(list.map((h) => [h.id, h.version, h.models.length])).toEqual([
      ['claude', '2.1.303', 0],
      ['cursor', '2026.10.16-e3cb207', 0]
    ])
    expect(box.runs().every((r) => r.args.includes('--version'))).toBe(true)
  })

  it('respects only and the harnesses list', async () => {
    const client = createClient({ path: box.bin, harnesses: ['claude', 'cursor'] })
    expect((await client.getHarnesses({ only: ['cursor', 'codex'] })).map((h) => h.id)).toEqual(['cursor'])
    await expect(client.getHarness('codex')).rejects.toMatchObject({ code: 'UNKNOWN_HARNESS' })
  })

  it('reports a missing login and skips the model list', async () => {
    vi.stubEnv('FAKE_LOGGED_IN', '0')
    const client = createClient({ path: box.bin })
    const claude = await client.getHarness('claude')
    expect(claude.auth.loggedIn).toBe(false)
    const cursor = await client.getHarness('cursor')
    expect(cursor.auth.loggedIn).toBe(false)
    expect(cursor.models.map((m) => m.id)).toEqual([''])
    expect(box.runs().some((r) => r.kind === 'cursor' && r.args[0] === 'models')).toBe(false)
  })

  it('reads defaults from the user configuration', async () => {
    mkdirSync(join(box.home, '.claude'))
    writeFileSync(join(box.home, '.claude', 'settings.json'), JSON.stringify({ model: 'sonnet', effortLevel: 'high' }))
    mkdirSync(join(box.home, '.codex'))
    writeFileSync(join(box.home, '.codex', 'config.toml'), 'model = "gpt-5.3-codex"\nmodel_reasoning_effort = "low"\n[profiles.x]\nmodel = "other"\n')
    const client = createClient({ path: box.bin })
    const claude = await client.getHarness('claude')
    expect(claude).toMatchObject({ defaultModel: 'sonnet', defaultEffort: 'high' })
    // The default entry follows the configured model: Sonnet has no fast mode.
    expect(claude.models[0]).toMatchObject({ id: '', fast: false })
    expect(await client.getHarness('codex')).toMatchObject({ defaultModel: 'gpt-5.3-codex', defaultEffort: 'low' })
  })

  it('caches discovery and refreshes on demand', async () => {
    const client = createClient({ path: box.bin, harnesses: ['claude'] })
    await client.getHarnesses()
    const first = box.runs().length
    await client.getHarnesses()
    expect(box.runs().length).toBe(first)
    await client.getHarnesses({ refresh: true })
    expect(box.runs().length).toBe(first * 2)
    client.clearCache()
    await client.getHarnesses()
    expect(box.runs().length).toBe(first * 3)
  })

  it('refresh also re-reads the model catalog', async () => {
    const client = createClient({ path: box.bin, harnesses: ['cursor'] })
    const models = () => box.runs().filter((r) => r.args[0] === 'models').length
    await client.getHarness('cursor')
    await client.getModels('cursor')
    expect(models()).toBe(1)
    await client.getHarness('cursor', { refresh: true })
    expect(models()).toBe(2)
  })

  it('uses a binary override, relative paths included', async () => {
    const client = createClient({ path: '/nowhere', bins: { claude: join(box.bin, 'claude') } })
    expect((await client.getHarness('claude', { detail: 'basic' })).installed).toBe(true)
    expect((await client.getHarness('cursor', { detail: 'basic' })).installed).toBe(false)
  })
})

describe('getModels', () => {
  it('returns the catalog, and caches the CLI list', async () => {
    const client = createClient({ path: box.bin })
    const a = await client.getModels('cursor')
    await client.getModels('cursor')
    expect(box.runs().filter((r) => r.args[0] === 'models').length).toBe(1)
    expect(a.custom).toBe(true)
    await client.getModels('cursor', { refresh: true })
    expect(box.runs().filter((r) => r.args[0] === 'models').length).toBe(2)
  })

  it('gives a built-in catalog without the CLI, refuses one that comes from the CLI', async () => {
    const client = createClient({ path: '/nowhere' })
    const claude = await client.getModels('claude')
    expect(claude.models.map((m) => m.id)).toEqual(['', 'opus', 'sonnet', 'haiku', 'fable'])
    const err = await client.getModels('cursor').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HarnessError)
    expect(err).toMatchObject({ code: 'NOT_INSTALLED', harness: 'cursor' })
  })
})
