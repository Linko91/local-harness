// OpenCode (`opencode run`), using the providers set up with `opencode auth login`.
// Experimental: the flags follow OpenCode's documentation but were not tried on a real install.

import { join } from 'node:path'
import { cliError } from '../errors.js'
import { partsToText } from '../images.js'
import { str, stripControl } from '../text.js'
import type { ModelInfo } from '../types.js'
import { type Adapter, type AdapterContext, catalogCaps, readJson } from './adapter.js'

const configFile = (ctx: AdapterContext): string =>
  join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config'), 'opencode', 'opencode.json')

/** `opencode models` prints one `provider/model` per line. */
export function parseOpencodeModels(stdout: string): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const raw of stripControl(stdout).split('\n')) {
    const id = raw.trim()
    if (!/^[\w.-]+\/[\w.:@\-[\]/]+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: id, efforts: [], fast: false })
  }
  return out
}

export const opencode: Adapter = {
  id: 'opencode',
  name: 'OpenCode',
  bins: ['opencode'],
  loginCommand: 'opencode auth login',
  verified: false,
  images: false,
  efforts: [],
  cliCatalog: false,

  async auth(run) {
    const a = await run(['auth', 'list'])
    const m = /(\d+)\s+credentials?/i.exec(stripControl(`${a.stdout}\n${a.stderr}`))
    return { loggedIn: m?.[1] !== undefined ? Number(m[1]) > 0 : null }
  },

  async catalog(run, ctx) {
    const defaultModel = str((await readJson(configFile(ctx)))?.model) ?? null
    const models: ModelInfo[] = [{ id: '', label: 'Default', efforts: [], fast: false, isDefault: true }]
    if (run) {
      const out = await run(['models'])
      if (out.code === 0) models.push(...parseOpencodeModels(out.stdout))
    }
    return { models, custom: true, defaultModel, source: run ? 'cli' : 'catalog' }
  },

  async defaultEffort() {
    return null
  },

  acceptsModel: (value) => typeof value === 'string' && /^[\w.:@/[\]-]{0,96}$/.test(value),
  caps: catalogCaps,

  async build({ parts, system, resolved }) {
    const text = partsToText(parts)
    return {
      args: ['run', ...(resolved.model ? ['-m', resolved.model] : [])],
      optional: [],
      optionalCarries: [],
      input: system !== undefined ? `${system}\n\n---\n\n${text}` : text
    }
  },

  parse(out) {
    const text = stripControl(out.stdout).trim()
    if (out.code !== 0) throw cliError(opencode, stripControl(out.stderr).trim() || text || `exit code ${out.code}`, out.code)
    return { text }
  }
}
