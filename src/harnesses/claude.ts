// Claude Code in headless mode (`claude -p`), using the login from `claude auth login`.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cliError } from '../errors.js'
import { hasImages } from '../images.js'
import { isRecord, jsonLines, num, resultObject, str } from '../text.js'
import type { Effort, ModelCatalog, ModelInfo } from '../types.js'
import { type Adapter, type AdapterContext, failureDetail, isEffortValue, readJson } from './adapter.js'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Claude Code has no command that lists models, and the aliases always follow the
 * latest version of each family: the catalog has only the aliases. Full names
 * (`claude-…`) are still accepted as custom models.
 */
const ALIASES: ModelInfo[] = [
  { id: 'opus', label: 'Opus', efforts: EFFORTS, fast: true },
  { id: 'sonnet', label: 'Sonnet', efforts: EFFORTS, fast: false },
  { id: 'haiku', label: 'Haiku', efforts: [], fast: false },
  { id: 'fable', label: 'Fable', efforts: EFFORTS, fast: false }
]

const MODEL_RE = /^(?:claude-[\w.-]{1,60}|[a-z][\w.-]{0,30})(?:\[\w+\])?$/

/** Fast mode exists only for Opus; Haiku has no effort levels. */
function capsOf(model: string): { efforts: Effort[]; fast: boolean } {
  const base = model.replace(/\[\w+\]$/, '')
  const alias = ALIASES.find((m) => m.id === base)
  if (alias) return { efforts: alias.efforts, fast: alias.fast }
  if (/^claude-opus-/.test(base)) return { efforts: EFFORTS, fast: true }
  if (/^claude-haiku-/.test(base)) return { efforts: [], fast: false }
  return { efforts: EFFORTS, fast: false }
}

const configDir = (ctx: AdapterContext): string => ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude')
const settings = (ctx: AdapterContext) => readJson(join(configDir(ctx), 'settings.json'))

export const claude: Adapter = {
  id: 'claude',
  name: 'Claude Code',
  bins: ['claude'],
  loginCommand: 'claude auth login',
  verified: true,
  images: true,
  efforts: EFFORTS,
  // With an API key in the environment Claude Code bills per use instead of using the subscription.
  apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  cliCatalog: false,

  async auth(run) {
    // Exits 0 when logged in, 1 when not; old versions have no such command.
    const a = await run(['auth', 'status'])
    const json = jsonLines(a.stdout)[0]
    const method = str(json?.authMethod)
    if (typeof json?.loggedIn === 'boolean') return { loggedIn: json.loggedIn, ...(method ? { method } : {}) }
    if (a.code === 0) return { loggedIn: true, ...(method ? { method } : {}) }
    if (a.code === 1 && !/unknown|usage:/i.test(a.stderr)) return { loggedIn: false }
    return { loggedIn: null }
  },

  async catalog(_run, ctx): Promise<ModelCatalog> {
    const s = await settings(ctx)
    const defaultModel = ctx.env.ANTHROPIC_MODEL || str(s?.model) || null
    const def = defaultModel ? capsOf(defaultModel) : { efforts: EFFORTS, fast: true }
    return {
      models: [{ id: '', label: 'Default', ...def, isDefault: true }, ...ALIASES.map((m) => ({ ...m }))],
      custom: true,
      defaultModel,
      source: 'catalog'
    }
  },

  async defaultEffort(ctx) {
    const level = (await settings(ctx))?.effortLevel
    return isEffortValue(level) ? level : null
  },

  acceptsModel: (value) => typeof value === 'string' && (value === '' || MODEL_RE.test(value)),

  caps(model, catalog) {
    if (!model) return { efforts: catalog.models[0]?.efforts ?? EFFORTS, fast: catalog.models[0]?.fast ?? true }
    return capsOf(model)
  },

  async build({ parts, system, resolved, workDir, isolation }) {
    const images = hasImages(parts)
    const args = ['-p']
    if (images) args.push('--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose')
    else args.push('--output-format', 'json')
    if (system !== undefined) {
      const file = join(workDir, 'system.md')
      await fs.writeFile(file, system, 'utf8')
      // Replaces the "coding agent" system prompt.
      args.push('--system-prompt-file', file)
    }
    args.push('--tools', '') // text only: no tools
    if (resolved.model) args.push('--model', resolved.model)

    const optional = [
      '--no-session-persistence', // keeps `claude --resume` history clean
      ...(isolation === 'clean' ? ['--safe-mode'] : []), // ignores CLAUDE.md, skills, hooks, MCP
      ...(resolved.effort ? ['--effort', resolved.effort] : []),
      // There is no flag: in headless mode fast mode is a session setting.
      ...(resolved.fast !== null ? ['--settings', JSON.stringify({ fastMode: resolved.fast })] : [])
    ]
    const optionalCarries: Array<'effort' | 'fast'> = []
    if (resolved.effort) optionalCarries.push('effort')
    if (resolved.fast !== null) optionalCarries.push('fast')

    let input: string
    if (images) {
      const content = parts.map((p) =>
        p.type === 'text'
          ? { type: 'text', text: p.text }
          : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data.toString('base64') } }
      )
      input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
    } else {
      input = parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    }
    return { args, optional, optionalCarries, input }
  },

  parse(out) {
    const json = resultObject(out.stdout)
    if (!json || json.is_error || typeof json.result !== 'string') throw cliError(claude, failureDetail(out, json), out.code)
    const init = jsonLines(out.stdout).find((o) => o.type === 'system' && o.subtype === 'init')
    // Side calls can show up in modelUsage too: the answer comes from the model that wrote the most.
    const modelUsage = isRecord(json.modelUsage)
      ? Object.entries(json.modelUsage)
          .map(([name, u]) => [name, isRecord(u) ? (num(u.outputTokens) ?? 0) : 0] as const)
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name)
      : []
    const usage = (json.usage ?? {}) as Record<string, unknown>
    const input = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
      .map(num)
      .filter((n): n is number => n !== undefined)
    const model = str(init?.model) ?? modelUsage[0]
    const cliDurationMs = num(json.duration_ms)
    const sessionId = str(json.session_id)
    return {
      text: json.result,
      ...(model ? { model } : {}),
      ...(cliDurationMs !== undefined ? { cliDurationMs } : {}),
      usage: {
        ...(input.length ? { inputTokens: input.reduce((a, b) => a + b, 0) } : {}),
        ...(num(usage.output_tokens) !== undefined ? { outputTokens: num(usage.output_tokens) } : {}),
        ...(num(json.total_cost_usd) !== undefined ? { costUsd: num(json.total_cost_usd) } : {})
      },
      ...(sessionId ? { sessionId } : {})
    }
  }
}
