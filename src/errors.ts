import type { HarnessId } from './types.js'

export type HarnessErrorCode =
  | 'UNKNOWN_HARNESS'
  | 'NOT_INSTALLED'
  | 'NOT_LOGGED_IN'
  | 'USAGE_LIMIT'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_INPUT'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INVALID_JSON'
  | 'CLI_ERROR'

/** Every error the library throws. `code` is stable; `message` is English and meant for people. */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly harness: HarnessId | null
  /** The CLI's own output, for logs. */
  readonly raw: string
  readonly exitCode: number | null

  constructor(
    code: HarnessErrorCode,
    message: string,
    details: { harness?: HarnessId | null; raw?: string; exitCode?: number | null; cause?: unknown } = {}
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'HarnessError'
    this.code = code
    this.harness = details.harness ?? null
    this.raw = details.raw ?? ''
    this.exitCode = details.exitCode ?? null
  }
}

export function isHarnessError(err: unknown, code?: HarnessErrorCode): err is HarnessError {
  return err instanceof HarnessError && (code === undefined || err.code === code)
}

/** Sort a CLI's error text into a code. */
export function classifyError(detail: string): HarnessErrorCode {
  const d = detail.toLowerCase()
  if (/not logged in|log ?in|unauthori[sz]ed|authenticat|\b401\b/.test(d)) return 'NOT_LOGGED_IN'
  if (d.includes('limit') && /usage|rate|reached|quota/.test(d)) return 'USAGE_LIMIT'
  if (d.includes('model') && /not found|not available|invalid|unknown|does not exist|not supported/.test(d))
    return 'UNKNOWN_MODEL'
  return 'CLI_ERROR'
}

export function cliError(
  harness: { id: HarnessId; name: string; loginCommand: string },
  detail: string,
  exitCode: number | null
): HarnessError {
  const code = classifyError(detail)
  const short = detail.slice(0, 500)
  const message =
    code === 'NOT_LOGGED_IN'
      ? `${harness.name} is not logged in. Run in a terminal: ${harness.loginCommand}`
      : code === 'USAGE_LIMIT'
        ? `${harness.name} reached its usage limit: ${short}`
        : code === 'UNKNOWN_MODEL'
          ? `${harness.name} does not know this model: ${short}`
          : `${harness.name} returned an error: ${short}`
  return new HarnessError(code, message, { harness: harness.id, raw: detail, exitCode })
}

export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
