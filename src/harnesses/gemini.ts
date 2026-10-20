// Gemini CLI (`gemini -p`), using the login done in the interactive CLI.
// Experimental: the flags follow Gemini CLI's documentation but were not tried on a real install.

import { join } from 'node:path'
import { cliError } from '../errors.js'
import { partsToText } from '../images.js'
import { isRecord, resultObject, str } from '../text.js'
import { type Adapter, type AdapterContext, catalogCaps, failureDetail, fileExists, readJson } from './adapter.js'

const settings = (ctx: AdapterContext) => readJson(join(ctx.home, '.gemini', 'settings.json'))

export const gemini: Adapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  bins: ['gemini'],
  loginCommand: 'gemini',
  verified: false,
  images: false,
  efforts: [],
  cliCatalog: false,

  // No status command: an API key in the environment or saved OAuth credentials mean logged in.
  async auth(_run, ctx) {
    if (ctx.env.GEMINI_API_KEY || ctx.env.GOOGLE_API_KEY) return { loggedIn: true, method: 'api-key' }
    if (ctx.env.GOOGLE_GENAI_USE_VERTEXAI) return { loggedIn: true, method: 'vertex-ai' }
    if (await fileExists(join(ctx.home, '.gemini', 'oauth_creds.json'))) return { loggedIn: true, method: 'oauth' }
    return { loggedIn: null }
  },

  async catalog(_run, ctx) {
    const s = await settings(ctx)
    const model = isRecord(s?.model) ? str(s.model.name) : str(s?.model)
    return {
      models: [{ id: '', label: 'Default', efforts: [], fast: false, isDefault: true }],
      custom: true,
      defaultModel: ctx.env.GEMINI_MODEL || model || null,
      source: 'catalog'
    }
  },

  async defaultEffort() {
    return null
  },

  acceptsModel: (value) => typeof value === 'string' && /^[\w.:/-]{0,64}$/.test(value),
  caps: catalogCaps,

  async build({ parts, system, resolved }) {
    const text = partsToText(parts)
    const args = [...(resolved.model ? ['-m', resolved.model] : []), '-p', 'Follow the instructions given on stdin.']
    return {
      args,
      optional: ['--output-format', 'json'],
      optionalCarries: [],
      input: system !== undefined ? `${system}\n\n---\n\n${text}` : text
    }
  },

  parse(out) {
    const json = resultObject(out.stdout)
    const error = json?.error
    if (out.code !== 0 || error) throw cliError(gemini, failureDetail(out, json ? { error } : null), out.code)
    if (json && typeof json.response === 'string') {
      const stats = isRecord(json.stats) && isRecord(json.stats.models) ? Object.keys(json.stats.models) : []
      return { text: json.response, ...(stats[0] ? { model: stats[0] } : {}) }
    }
    return { text: out.stdout.trim() }
  }
}
