import { createClient } from './client.js'
import { ADAPTERS, isHarnessId } from './harnesses/index.js'
import { isEffortValue } from './harnesses/adapter.js'
import type { Effort, HarnessId } from './types.js'

export { createClient } from './client.js'
export { loginShellPath, setLoginShellPath } from './env.js'
export { HarnessError, isHarnessError, type HarnessErrorCode } from './errors.js'
export { HARNESS_IDS, isHarnessId } from './harnesses/index.js'
export { extractJson, unwrapText } from './text.js'
export type * from './types.js'

const defaultClient = createClient()

/** The agent CLIs installed on this machine (all of them with `includeMissing`). */
export const getHarnesses: typeof defaultClient.getHarnesses = (options) => defaultClient.getHarnesses(options)
/** One agent CLI, installed or not. */
export const getHarness: typeof defaultClient.getHarness = (id, options) => defaultClient.getHarness(id, options)
/** The models an installed agent CLI offers. */
export const getModels: typeof defaultClient.getModels = (id, options) => defaultClient.getModels(id, options)
/** Send a prompt to an agent CLI and return its answer. */
export const ask: typeof defaultClient.ask = (id, prompt, options) => defaultClient.ask(id, prompt, options)
/** Cancel a request started with `requestId`. `false` if it was not running. */
export const cancel: typeof defaultClient.cancel = (requestId) => defaultClient.cancel(requestId)
/** The arguments `ask()` would pass to the CLI, without running it. */
export const resolveArgs: typeof defaultClient.resolveArgs = (id, prompt, options) =>
  defaultClient.resolveArgs(id, prompt, options)
/** Forget cached discovery results and model catalogs. */
export const clearCache = (): void => defaultClient.clearCache()

/** Whether `value` is an effort level (one the harness accepts, when given). */
export function isEffort(value: unknown, harness?: HarnessId): value is Effort {
  if (!isEffortValue(value)) return false
  return harness === undefined || (isHarnessId(harness) && ADAPTERS[harness].efforts.includes(value))
}

/** Whether a model name is acceptable for a harness, by syntax alone (no process is started). */
export function acceptsModel(harness: HarnessId, value: unknown): boolean {
  return isHarnessId(harness) && ADAPTERS[harness].acceptsModel(value)
}
