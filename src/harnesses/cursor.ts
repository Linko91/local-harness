// Cursor Agent in headless mode (`agent -p`), using the login from `agent login`.
//
// Cursor encodes effort and speed in the model id ("gpt-5.3-codex-high-fast"):
// the catalog groups variants into one model per family, and `ask()` picks the
// variant for the chosen effort and speed.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cliError } from '../errors.js'
import { DEFAULT_IMAGE_HINT, hasImages, partsToText } from '../images.js'
import { jsonLines, num, resultObject, str, stripControl } from '../text.js'
import type { Effort, ModelCatalog, ModelInfo, ModelVariant } from '../types.js'
import { type Adapter, EFFORTS, catalogCaps, failureDetail, findModel } from './adapter.js'

const VARIANT_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const CURSOR_MODEL_RE = /^[\w.:/-]{0,64}$/

interface ParsedVariant extends ModelVariant {
  family: string
  /** Marked "(default)" or "(current)" by the CLI. */
  marked: boolean
}

/**
 * `agent models` prints one model per line, `id - Label`, between a heading
 * ("Available models") and a closing tip. The format is not guaranteed: lines
 * that do not start with something shaped like an id are skipped.
 */
export function parseCursorModels(stdout: string): ParsedVariant[] {
  const out: ParsedVariant[] = []
  const seen = new Set<string>()
  for (const raw of stripControl(stdout).split('\n')) {
    const line = raw.trim().replace(/^[-*•]\s+/, '')
    if (!line || /^(?:available models|no models|usage|tip|loading)\b/i.test(line)) continue
    const m = /^([\w][\w.:/-]{0,63})(?:\s+[-–:]\s+(.+)|\s+\((.+)\))?\s*$/.exec(line)
    if (!m?.[1] || seen.has(m[1])) continue
    seen.add(m[1])
    let label = (m[2] ?? m[3] ?? '').trim()
    const marked = /\((?:default|current)\)\s*$/i.test(label)
    label = label.replace(/\s*\((?:default|current)\)\s*$/i, '').trim() || m[1]
    const id = m[1]
    const fast = id.endsWith('-fast')
    const base = fast ? id.slice(0, -5) : id
    const e = new RegExp(`-(${VARIANT_EFFORTS.join('|')})$`).exec(base)
    const effort = (e?.[1] as Effort | undefined) ?? null
    out.push({ id, label, family: e ? base.slice(0, -e[0].length) : base, effort, fast, marked })
  }
  return out
}

const EFFORT_WORDS = /\s+(?:low|medium|high|extra high|max|fast)$/i

/** One model per family; a single fixed effort is not a choice. */
export function cursorCatalog(variants: ParsedVariant[]): ModelCatalog {
  const families = new Map<string, ParsedVariant[]>()
  for (const v of variants) {
    if (v.id === 'auto') continue
    families.set(v.family, [...(families.get(v.family) ?? []), v])
  }
  const models: ModelInfo[] = [{ id: '', label: 'Auto', efforts: [], fast: false, isDefault: true }]
  for (const [family, vs] of families) {
    let label = vs.map((v) => v.label).sort((a, b) => a.length - b.length)[0] ?? family
    while (EFFORT_WORDS.test(label)) label = label.replace(EFFORT_WORDS, '')
    const efforts = VARIANT_EFFORTS.filter((e) => vs.some((v) => v.effort === e))
    const choosable = efforts.length > 1 || (efforts.length === 1 && vs.some((v) => !v.effort))
    models.push({
      id: family,
      label: label.replace(/\s+/g, ' ').trim(),
      efforts: choosable ? efforts : [],
      fast: vs.some((v) => v.fast),
      variants: vs.map(({ id, label: l, effort, fast }) => ({ id, label: l, effort, fast }))
    })
  }
  const marked = variants.find((v) => v.marked && v.id !== 'auto')
  return { models, custom: true, defaultModel: marked?.id ?? null, source: 'cli' }
}

/** The concrete id for a family, effort and speed; falls back to the nearest variant. */
export function pickVariant(variants: ModelVariant[], effort: Effort | null, fast: boolean): ModelVariant | undefined {
  if (!variants.length) return undefined
  const order: Array<Effort | null> = [effort, null, 'medium', 'high', ...EFFORTS]
  const atEffort = order.map((e) => variants.filter((v) => v.effort === e)).find((list) => list.length) ?? variants
  return atEffort.find((v) => v.fast === fast) ?? atEffort[0]
}

const DEFAULT_ONLY: ModelCatalog = {
  models: [{ id: '', label: 'Auto', efforts: [], fast: false, isDefault: true }],
  custom: true,
  defaultModel: null,
  source: 'cli'
}

export const cursor: Adapter = {
  id: 'cursor',
  name: 'Cursor Agent',
  // Older installs only have `cursor-agent`.
  bins: ['agent', 'cursor-agent'],
  loginCommand: 'agent login',
  verified: true,
  images: true,
  efforts: VARIANT_EFFORTS,
  cliCatalog: true,

  async auth(run) {
    const a = await run(['status', '--format', 'json'])
    const json = jsonLines(a.stdout)[0]
    const flag = json?.isAuthenticated
    return { loggedIn: typeof flag === 'boolean' ? flag : null }
  },

  async catalog(run) {
    if (!run) return structuredClone(DEFAULT_ONLY)
    let out = await run(['models'])
    if (out.code !== 0 || !parseCursorModels(out.stdout).length) out = await run(['--list-models'])
    if (out.code !== 0) throw cliError(cursor, failureDetail(out, null), out.code)
    return cursorCatalog(parseCursorModels(out.stdout))
  },

  async defaultEffort() {
    return null
  },

  acceptsModel: (value) => typeof value === 'string' && CURSOR_MODEL_RE.test(value),

  caps(model, catalog) {
    // A family name wins over a variant with the same id ("gpt-5.3-codex" is both).
    if (catalog.models.some((m) => m.id === model)) return catalogCaps(model, catalog)
    const variant = findModel(catalog, model)?.variants?.find((v) => v.id === model)
    // A variant id already says its effort and speed: nothing left to choose.
    if (variant) return { efforts: variant.effort ? [variant.effort] : [], fast: variant.fast }
    return catalogCaps(model, catalog)
  },

  pick(model, effort, fast, catalog) {
    const entry = catalog.models.find((m) => m.id === model)
    if (entry?.variants?.length) {
      const v = pickVariant(entry.variants, effort, fast)
      if (v) return { model: v.id, effort: v.effort, fast: v.fast }
    }
    const variant = findModel(catalog, model)?.variants?.find((v) => v.id === model)
    if (variant) return { model, effort: variant.effort, fast: variant.fast }
    return { model, effort: null, fast: null }
  },

  async build({ parts, system, resolved, cwd, workDir, imageHint, imageListLabel }) {
    const images = hasImages(parts)
    // Cursor has no image input: the images become files in the request's own folder.
    for (const p of parts) if (p.type === 'image') await fs.writeFile(join(workDir, p.name), p.data)
    const text = partsToText(parts, imageListLabel)
    // No separate system prompt either: it goes at the top of the message.
    const prompt = [system, system !== undefined ? '---' : undefined, images ? imageHint || DEFAULT_IMAGE_HINT : undefined, text]
      .filter((s): s is string => s !== undefined)
      .join('\n\n')
    const args = ['-p', '--output-format', 'json', '--trust', '--workspace', cwd]
    if (resolved.model) args.push('--model', resolved.model)
    const optional = [
      '--mode',
      'ask', // read-only: no file edits, no commands
      ...(images && cwd !== workDir ? ['--add-dir', workDir] : [])
    ]
    return { args, optional, optionalCarries: [], input: prompt }
  },

  parse(out) {
    const json = resultObject(out.stdout)
    if (!json || json.is_error || typeof json.result !== 'string') throw cliError(cursor, failureDetail(out, json), out.code)
    const usage = (json.usage ?? {}) as Record<string, unknown>
    const inputTokens = num(usage.inputTokens)
    const outputTokens = num(usage.outputTokens)
    const cliDurationMs = num(json.duration_ms)
    const sessionId = str(json.session_id)
    return {
      text: json.result,
      ...(cliDurationMs !== undefined ? { cliDurationMs } : {}),
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {})
      },
      ...(sessionId ? { sessionId } : {})
    }
  }
}
