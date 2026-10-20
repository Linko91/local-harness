import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { childEnv, findBinary, resolveBin, searchPath } from './env.js'
import { HarnessError, isErrnoException } from './errors.js'
import type { Adapter, AdapterContext, BuildInput, Invocation, Resolved, RunCli } from './harnesses/adapter.js'
import { effortsUnion } from './harnesses/adapter.js'
import { ADAPTERS, HARNESS_IDS } from './harnesses/index.js'
import { DEFAULT_IMAGE_HINT, hasImages, loadParts } from './images.js'
import { exec } from './process.js'
import { rejectsFlag } from './process.js'
import { parseVersion, unwrapText } from './text.js'
import type {
  AskOptions,
  AskResult,
  ClientConfig,
  DiscoveryOptions,
  Effort,
  Harness,
  HarnessClient,
  HarnessId,
  ModelCatalog,
  PromptPart
} from './types.js'

const CHECK_TIMEOUT_MS = 15_000
const ASK_TIMEOUT_MS = 180_000

interface Cached<T> {
  at: number
  value: Promise<T>
}

export function createClient(config: ClientConfig = {}): HarnessClient {
  const known = config.harnesses?.length ? HARNESS_IDS.filter((id) => config.harnesses?.includes(id)) : HARNESS_IDS
  const ttl = { discovery: config.cacheTtlMs?.discovery ?? 60_000, models: config.cacheTtlMs?.models ?? 600_000 }
  const discoveryCache = new Map<string, Cached<Harness>>()
  const modelCache = new Map<HarnessId, Cached<ModelCatalog>>()
  const running = new Map<string, AbortController>()

  function adapterOf(id: HarnessId): Adapter {
    const adapter = known.includes(id) ? ADAPTERS[id] : undefined
    if (!adapter) throw new HarnessError('UNKNOWN_HARNESS', `Unknown agent CLI: ${String(id)}`)
    return adapter
  }

  const context = (): AdapterContext => ({ env: process.env, home: homedir() })

  /** Remember a promise for `ms`; a rejected one is forgotten at once. */
  function cached<K, T>(map: Map<K, Cached<T>>, key: K, ms: number, refresh: boolean | undefined, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key)
    if (!refresh && hit && Date.now() - hit.at < ms) return hit.value
    const value = load()
    map.set(key, { at: Date.now(), value })
    value.catch(() => {
      if (map.get(key)?.value === value) map.delete(key)
    })
    return value
  }

  function namesOf(adapter: Adapter): string[] {
    const override = config.bins?.[adapter.id]
    return override ? [resolveBin(override)] : adapter.bins
  }

  async function locate(adapter: Adapter): Promise<{ bin: string | null; path: string }> {
    const path = await searchPath(config.path)
    return { bin: await findBinary(namesOf(adapter), path), path }
  }

  const envFor = (adapter: Adapter, path: string, extra?: Record<string, string>): NodeJS.ProcessEnv =>
    childEnv(path, extra, config.keepApiKeys ? [] : (adapter.apiKeyEnv ?? []))

  function runner(adapter: Adapter, bin: string, path: string): RunCli {
    const env = envFor(adapter, path)
    return (args) => exec(bin, args, { env, timeoutMs: CHECK_TIMEOUT_MS, cwd: tmpdir(), label: adapter.name, harness: adapter.id })
  }

  function notInstalled(adapter: Adapter): HarnessError {
    return new HarnessError(
      'NOT_INSTALLED',
      `${adapter.name} is not installed: ${namesOf(adapter).join(' or ')} not found in the PATH.`,
      { harness: adapter.id }
    )
  }

  /** The catalog from the CLI, cached; the built-in one when the CLI cannot be asked. */
  function catalogOf(adapter: Adapter, run: RunCli | null, refresh?: boolean): Promise<ModelCatalog> {
    if (!run || !adapter.cliCatalog) return adapter.catalog(run, context())
    return cached(modelCache, adapter.id, ttl.models, refresh, () => adapter.catalog(run, context()))
  }

  async function probe(adapter: Adapter, detail: 'basic' | 'full'): Promise<Harness> {
    const info: Harness = {
      id: adapter.id,
      name: adapter.name,
      installed: false,
      bin: null,
      version: null,
      versionText: null,
      verified: adapter.verified,
      images: adapter.images,
      auth: { loggedIn: null, loginCommand: adapter.loginCommand },
      models: [],
      defaultModel: null,
      defaultEffort: null,
      efforts: [],
      fast: false,
      customModels: true,
      modelsSource: adapter.cliCatalog ? 'cli' : 'catalog'
    }
    const { bin, path } = await locate(adapter)
    info.bin = bin
    const run = bin ? runner(adapter, bin, path) : null
    if (run) {
      try {
        const v = await run(['--version'])
        if (v.code === 0) Object.assign(info, { installed: true }, parseVersion(v.stdout || v.stderr))
      } catch {
        // not runnable: stays "not installed"
      }
    }
    if (detail === 'basic') return info

    const ctx = context()
    if (info.installed && run) {
      try {
        info.auth = { ...(await adapter.auth(run, ctx)), loginCommand: adapter.loginCommand }
      } catch {
        // Not knowing is not an error: the first request will tell.
      }
    }
    let catalog: ModelCatalog
    try {
      // Without a login the CLI cannot list models.
      catalog = await catalogOf(adapter, info.installed && info.auth.loggedIn !== false ? run : null)
    } catch {
      catalog = await adapter.catalog(null, ctx)
    }
    info.models = catalog.models
    info.defaultModel = catalog.defaultModel
    info.customModels = catalog.custom
    info.modelsSource = catalog.source
    info.efforts = effortsUnion(catalog.models)
    info.fast = catalog.models.some((m) => m.fast || m.variants?.some((v) => v.fast))
    info.defaultEffort = await adapter.defaultEffort(ctx).catch(() => null)
    return info
  }

  async function getHarness(id: HarnessId, options: Omit<DiscoveryOptions, 'only' | 'includeMissing'> = {}): Promise<Harness> {
    const adapter = adapterOf(id)
    const detail = options.detail ?? 'full'
    return cached(discoveryCache, `${id}:${detail}`, ttl.discovery, options.refresh, () => probe(adapter, detail))
  }

  async function getHarnesses(options: DiscoveryOptions = {}): Promise<Harness[]> {
    const ids = options.only?.length ? known.filter((id) => options.only?.includes(id)) : known
    const list = await Promise.all(ids.map((id) => getHarness(id, { detail: options.detail, refresh: options.refresh })))
    return options.includeMissing ? list : list.filter((h) => h.installed)
  }

  async function getModels(id: HarnessId, options: { refresh?: boolean } = {}): Promise<ModelCatalog> {
    const adapter = adapterOf(id)
    const { bin, path } = await locate(adapter)
    if (!bin) throw notInstalled(adapter)
    return catalogOf(adapter, runner(adapter, bin, path), options.refresh)
  }

  /** Model, effort and fast mode as the CLI will get them; what the model lacks is dropped (or refused when strict). */
  function resolveOptions(adapter: Adapter, options: AskOptions, catalog: ModelCatalog): Resolved {
    const model = options.model ?? ''
    const caps = adapter.caps(model, catalog)
    const unsupported = (what: string): HarnessError =>
      new HarnessError('UNSUPPORTED_OPTION', `${adapter.name}: ${what} is not available for model "${model || 'default'}".`, {
        harness: adapter.id
      })

    let effort: Effort | null = null
    if (options.effort) {
      if (caps.efforts.includes(options.effort)) effort = options.effort
      else if (options.strict) throw unsupported(`effort "${options.effort}"`)
    }
    if (options.fast === true && !caps.fast && options.strict) throw unsupported('fast mode')
    // Fast mode is off unless asked for; where the model has it, "off" is said explicitly.
    const fast = caps.fast ? options.fast === true : null

    if (adapter.pick && model) return adapter.pick(model, effort, fast === true, catalog)
    return { model: model || null, effort, fast }
  }

  async function prepare(
    id: HarnessId,
    prompt: string | PromptPart[],
    options: AskOptions,
    workDir: string
  ): Promise<{ adapter: Adapter; bin: string; path: string; inv: Invocation; resolved: Resolved; cwd: string }> {
    const adapter = adapterOf(id)
    const { bin, path } = await locate(adapter)
    if (!bin) throw notInstalled(adapter)
    const parts = await loadParts(prompt, id)
    if (hasImages(parts) && !adapter.images)
      throw new HarnessError('UNSUPPORTED_INPUT', `${adapter.name} does not accept images.`, { harness: id })

    let catalog: ModelCatalog
    if (options.model && adapter.cliCatalog) {
      catalog = await catalogOf(adapter, runner(adapter, bin, path)).catch(() => adapter.catalog(null, context()))
    } else {
      catalog = await adapter.catalog(null, context())
    }
    const resolved = resolveOptions(adapter, options, catalog)
    const cwd = options.cwd ?? workDir
    const input: BuildInput = {
      parts,
      system: options.system,
      resolved,
      cwd,
      workDir,
      isolation: options.isolation ?? (options.cwd ? 'project' : 'clean'),
      imageHint: options.imageHint ?? DEFAULT_IMAGE_HINT
    }
    return { adapter, bin, path, inv: await adapter.build(input), resolved, cwd }
  }

  const newWorkDir = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'local-harness-'))
  const removeDir = (dir: string): Promise<void> => fs.rm(dir, { recursive: true, force: true }).catch(() => {})

  async function ask(id: HarnessId, prompt: string | PromptPart[], options: AskOptions = {}): Promise<AskResult> {
    const started = Date.now()
    const controller = new AbortController()
    const { requestId, signal } = options
    if (requestId !== undefined) {
      running.get(requestId)?.abort()
      running.set(requestId, controller)
    }
    const onAbort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', onAbort)

    const workDir = await newWorkDir()
    try {
      if (controller.signal.aborted) throw new HarnessError('ABORTED', 'Request cancelled.', { harness: id })
      const { adapter, bin, path, inv, resolved, cwd } = await prepare(id, prompt, options, workDir)
      const env = envFor(adapter, path, options.env)
      const run = (args: string[]) =>
        exec(bin, args, {
          input: inv.input,
          cwd,
          env,
          timeoutMs: options.timeoutMs ?? config.timeoutMs ?? ASK_TIMEOUT_MS,
          signal: controller.signal,
          label: adapter.name,
          harness: id
        })

      const applied = { ...resolved }
      let args = [...inv.args, ...inv.optional, ...(inv.tail ?? [])]
      let out = await run(args).catch((err: unknown) => {
        if (isErrnoException(err) && err.code === 'ENOENT') throw notInstalled(adapter)
        throw err
      })
      if (inv.optional.length && rejectsFlag(out)) {
        // An older version that does not know a recent flag: retry with the required ones only.
        args = [...inv.args, ...(inv.tail ?? [])]
        out = await run(args)
        for (const key of inv.optionalCarries) applied[key] = null
      }
      const answer = adapter.parse(out)
      return {
        text: options.unwrap ? unwrapText(answer.text) : answer.text,
        harness: id,
        model: answer.model ?? null,
        durationMs: Date.now() - started,
        cliDurationMs: answer.cliDurationMs ?? null,
        ...(answer.usage && Object.keys(answer.usage).length ? { usage: answer.usage } : {}),
        ...(answer.sessionId ? { sessionId: answer.sessionId } : {}),
        applied,
        args,
        raw: out.stdout
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (requestId !== undefined && running.get(requestId) === controller) running.delete(requestId)
      await removeDir(workDir)
    }
  }

  function cancel(requestId: string): boolean {
    const controller = running.get(requestId)
    controller?.abort()
    return !!controller
  }

  async function resolveArgs(id: HarnessId, prompt: string | PromptPart[] = '', options: AskOptions = {}): Promise<string[]> {
    const workDir = await newWorkDir()
    try {
      const { inv } = await prepare(id, prompt, options, workDir)
      return [...inv.args, ...inv.optional, ...(inv.tail ?? [])]
    } finally {
      await removeDir(workDir)
    }
  }

  function clearCache(): void {
    discoveryCache.clear()
    modelCache.clear()
  }

  return { getHarnesses, getHarness, getModels, ask, cancel, resolveArgs, clearCache }
}
