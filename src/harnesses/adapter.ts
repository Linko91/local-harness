import { promises as fs } from 'node:fs'
import type { LoadedPart } from '../images.js'
import type { ExecResult } from '../process.js'
import { isRecord } from '../text.js'
import type { AuthInfo, Effort, HarnessId, ModelCatalog, ModelInfo } from '../types.js'

export const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Runs the harness's CLI with some arguments (version, login status, model list). */
export type RunCli = (args: string[]) => Promise<ExecResult>

export interface AdapterContext {
  env: NodeJS.ProcessEnv
  home: string
}

/** Model, effort and fast mode as they will be passed to the CLI; `null` = not passed. */
export interface Resolved {
  model: string | null
  effort: Effort | null
  fast: boolean | null
}

export interface BuildInput {
  parts: LoadedPart[]
  system: string | undefined
  resolved: Resolved
  /** Where the CLI runs. */
  cwd: string
  /** A new empty folder for this request, removed afterwards. Equal to `cwd` unless the caller chose one. */
  workDir: string
  isolation: 'clean' | 'project'
  imageHint: string
}

export interface Invocation {
  /** Arguments the CLI must accept. */
  args: string[]
  /** Useful but recent flags: dropped and retried without when the CLI refuses them. */
  optional: string[]
  /** Which resolved options live in `optional`, and are lost on a retry. */
  optionalCarries: Array<'effort' | 'fast'>
  /** Positional arguments that go last. */
  tail?: string[]
  /** What is written to stdin. */
  input: string
}

export interface Answer {
  text: string
  model?: string
  cliDurationMs?: number
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  sessionId?: string
}

/** Everything the library knows about one CLI. */
export interface Adapter {
  id: HarnessId
  name: string
  /** Executable names, in order of preference. */
  bins: string[]
  loginCommand: string
  verified: boolean
  images: boolean
  /** Efforts the harness can ever accept. */
  efforts: readonly Effort[]
  /** Environment variables removed unless `keepApiKeys`. */
  apiKeyEnv?: string[]
  /** Whether resolving a model for `ask()` needs the catalog from the CLI. */
  cliCatalog: boolean
  auth(run: RunCli, ctx: AdapterContext): Promise<Omit<AuthInfo, 'loginCommand'>>
  /** The catalog; `run` is `null` when the CLI cannot or should not be asked. */
  catalog(run: RunCli | null, ctx: AdapterContext): Promise<ModelCatalog>
  defaultEffort(ctx: AdapterContext): Promise<Effort | null>
  acceptsModel(value: unknown): boolean
  /** Efforts and fast mode of a model, including names outside the catalog. */
  caps(model: string, catalog: ModelCatalog): { efforts: Effort[]; fast: boolean }
  /** The `--model` value for a model, effort and speed (Cursor picks a variant). Default: the model itself. */
  pick?(model: string, effort: Effort | null, fast: boolean, catalog: ModelCatalog): Resolved
  build(input: BuildInput): Promise<Invocation>
  /** Read the answer, or throw a HarnessError. */
  parse(out: ExecResult): Answer
}

/** A model's entry: by id, or by the id of one of its variants. */
export function findModel(catalog: ModelCatalog, id: string): ModelInfo | undefined {
  return catalog.models.find((m) => m.id === id) ?? catalog.models.find((m) => m.variants?.some((v) => v.id === id))
}

/** Default capabilities: the catalog entry, or the default model's for a name outside it. */
export function catalogCaps(model: string, catalog: ModelCatalog): { efforts: Effort[]; fast: boolean } {
  const entry = findModel(catalog, model) ?? catalog.models[0]
  return { efforts: entry?.efforts ?? [], fast: entry?.fast ?? false }
}

export const effortsUnion = (models: ModelInfo[]): Effort[] =>
  EFFORTS.filter((e) => models.some((m) => m.efforts.includes(e)))

export const isEffortValue = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** A JSON file, or `null` when missing or unreadable. */
export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The top-level `key = "value"` pairs of a TOML file (enough for Codex's config). */
export async function readTomlTop(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('[')) break
    const m = /^([\w.-]+)\s*=\s*"([^"]*)"/.exec(t) ?? /^([\w.-]+)\s*=\s*'([^']*)'/.exec(t)
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2]
  }
  return out
}

export const fileExists = async (path: string): Promise<boolean> =>
  fs.stat(path).then(
    () => true,
    () => false
  )

/** Detail of a failed run: the CLI's JSON error, else its stderr or stdout. */
export function failureDetail(out: ExecResult, json: Record<string, unknown> | null): string {
  const pick = (v: unknown): string => (typeof v === 'string' ? v : isRecord(v) && typeof v.message === 'string' ? v.message : '')
  return (
    pick(json?.result) ||
    pick(json?.error) ||
    (typeof json?.subtype === 'string' && json.subtype !== 'success' ? json.subtype : '') ||
    out.stderr.trim() ||
    out.stdout.trim() ||
    `exit code ${out.code}`
  )
}
