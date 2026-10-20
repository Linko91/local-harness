import { spawn } from 'node:child_process'
import process from 'node:process'
import { HarnessError } from './errors.js'
import type { HarnessId } from './types.js'

export interface ExecOptions {
  input?: string
  cwd?: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  /** Name used in error messages. */
  label: string
  harness?: HarnessId
}

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Windows `.cmd`/`.bat` shims (npm installs) can only be started through the shell. */
const needsShell = (bin: string): boolean => process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
const quoteForCmd = (arg: string): string => `"${arg.replace(/"/g, '""')}"`

/** Run a CLI to completion. Rejects with TIMEOUT or ABORTED, or with the spawn error (ENOENT…). */
export function exec(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new HarnessError('ABORTED', `${opts.label}: request cancelled.`, { harness: opts.harness }))
      return
    }
    const shell = needsShell(bin)
    const child = shell
      ? spawn(quoteForCmd(bin), args.map(quoteForCmd), { cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true })
      : spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() =>
        reject(
          new HarnessError('TIMEOUT', `${opts.label} did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds.`, {
            harness: opts.harness
          })
        )
      )
    }, opts.timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGTERM')
      finish(() => reject(new HarnessError('ABORTED', `${opts.label}: request cancelled.`, { harness: opts.harness })))
    }
    opts.signal?.addEventListener('abort', onAbort)

    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (err) => finish(() => reject(err)))
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })))
    // The CLI may exit before reading all of stdin (EPIPE); the close event reports it.
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.input ?? '')
  })
}

/** Did the CLI refuse a flag it does not know? Then the caller retries without the optional ones. */
export function rejectsFlag({ code, stdout, stderr }: ExecResult): boolean {
  return code !== 0 && /unknown (?:option|argument)|unrecognized|too many arguments/i.test(`${stderr}\n${stdout}`)
}
