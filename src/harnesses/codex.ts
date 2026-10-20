// OpenAI Codex CLI (`codex exec`), using the login from `codex login`.
// Experimental: the flags follow Codex's documentation but were not tried on a real install.

import { join } from 'node:path'
import { HarnessError, cliError } from '../errors.js'
import { partsToText } from '../images.js'
import { isRecord, jsonLines, num, str, stripControl } from '../text.js'
import type { Effort } from '../types.js'
import { type Adapter, type AdapterContext, catalogCaps, isEffortValue, readTomlTop } from './adapter.js'

const EFFORTS: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

const config = (ctx: AdapterContext) => readTomlTop(join(ctx.env.CODEX_HOME || join(ctx.home, '.codex'), 'config.toml'))

/** The final agent message from `codex exec --json` events, in the current or the older event format. */
function readEvents(stdout: string): { text?: string; error?: string; usage?: Record<string, unknown>; sessionId?: string } {
  const out: { text?: string; error?: string; usage?: Record<string, unknown>; sessionId?: string } = {}
  for (const e of jsonLines(stdout)) {
    const item = isRecord(e.item) ? e.item : null
    const msg = isRecord(e.msg) ? e.msg : null
    if (e.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') out.text = item.text
    else if (msg?.type === 'agent_message' && typeof msg.message === 'string') out.text = msg.message
    else if (e.type === 'thread.started' && typeof e.thread_id === 'string') out.sessionId = e.thread_id
    else if (e.type === 'turn.completed' && isRecord(e.usage)) out.usage = e.usage
    else if (e.type === 'turn.failed' && isRecord(e.error)) out.error = str(e.error.message) ?? 'turn failed'
    else if (e.type === 'error' || msg?.type === 'error') out.error = str(e.message) ?? str(msg?.message) ?? 'error'
  }
  return out
}

export const codex: Adapter = {
  id: 'codex',
  name: 'OpenAI Codex',
  bins: ['codex'],
  loginCommand: 'codex login',
  verified: false,
  images: true,
  efforts: EFFORTS,
  cliCatalog: false,

  async auth(run) {
    const a = await run(['login', 'status'])
    const text = stripControl(`${a.stdout}\n${a.stderr}`)
    if (a.code === 0) {
      const method = /chatgpt/i.test(text) ? 'chatgpt' : /api key/i.test(text) ? 'api-key' : undefined
      return { loggedIn: true, ...(method ? { method } : {}) }
    }
    return { loggedIn: /not logged in/i.test(text) ? false : null }
  },

  // Codex has no command that lists models: only the default, plus whatever the user configured.
  async catalog(_run, ctx) {
    const c = await config(ctx)
    return {
      models: [{ id: '', label: 'Default', efforts: EFFORTS, fast: false, isDefault: true }],
      custom: true,
      defaultModel: c.model || null,
      source: 'catalog'
    }
  },

  async defaultEffort(ctx) {
    const e = (await config(ctx)).model_reasoning_effort
    return isEffortValue(e) ? e : null
  },

  acceptsModel: (value) => typeof value === 'string' && /^[\w.:/-]{0,64}$/.test(value),
  caps: catalogCaps,

  async build({ parts, system, resolved, isolation, imageListLabel }) {
    const text = partsToText(parts, imageListLabel)
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json']
    if (resolved.model) args.push('-m', resolved.model)
    if (resolved.effort) args.push('-c', `model_reasoning_effort="${resolved.effort}"`)
    const optional = isolation === 'clean' ? ['--ephemeral'] : []
    const images = parts.flatMap((p) => (p.type === 'image' ? [`--image=${p.path}`] : []))
    return {
      args,
      optional,
      optionalCarries: [],
      // `-` reads the prompt from stdin; images come after it so they cannot swallow it.
      tail: ['-', ...images],
      input: system !== undefined ? `${system}\n\n---\n\n${text}` : text
    }
  },

  parse(out) {
    const events = readEvents(out.stdout)
    if (events.error || out.code !== 0) {
      throw cliError(codex, events.error || out.stderr.trim() || out.stdout.trim() || `exit code ${out.code}`, out.code)
    }
    const text = events.text ?? (jsonLines(out.stdout).length ? undefined : out.stdout.trim())
    if (text === undefined) throw new HarnessError('CLI_ERROR', 'OpenAI Codex returned no answer.', { harness: 'codex', raw: out.stdout })
    const u = events.usage ?? {}
    const inputTokens = num(u.input_tokens)
    const outputTokens = num(u.output_tokens)
    return {
      text,
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {})
      },
      ...(events.sessionId ? { sessionId: events.sessionId } : {})
    }
  }
}
