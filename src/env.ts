import { spawn } from 'node:child_process'
import { promises as fs, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

let shellPath: Promise<string> | null = null

const COMMON_DIRS = (): string[] =>
  process.platform === 'win32'
    ? []
    : [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.bun/bin')]

/** Use a fixed PATH instead of asking the login shell (tests, or a PATH the app already knows). */
export function setLoginShellPath(path: string): void {
  shellPath = Promise.resolve(path)
}

/**
 * The PATH of the user's login shell, merged with the process PATH and the usual
 * install folders. Apps started from the Finder get a minimal PATH that misses
 * ~/.local/bin, Homebrew and version managers, where these CLIs live.
 * Computed once.
 */
export function loginShellPath(): Promise<string> {
  shellPath ??= new Promise((done) => {
    const merge = (fromShell: string): string => {
      const parts = [...fromShell.split(delimiter), ...(process.env.PATH ?? '').split(delimiter), ...COMMON_DIRS()]
      return [...new Set(parts.filter(Boolean))].join(delimiter)
    }
    if (process.platform === 'win32') {
      done(merge(''))
      return
    }
    const shell = process.env.SHELL || '/bin/zsh'
    const marker = '__LOCAL_HARNESS_PATH__'
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      done(merge(''))
      return
    }
    const timer = setTimeout(() => child.kill(), 5000)
    child.stdout?.on('data', (d) => (out += d))
    const finish = (): void => {
      clearTimeout(timer)
      const m = new RegExp(`${marker}(.*)${marker}`).exec(out)
      done(merge(m?.[1] ?? ''))
    }
    child.on('close', finish)
    child.on('error', finish)
  })
  return shellPath
}

/** The PATH the CLIs are searched in and run with. */
export async function searchPath(mode: string | undefined): Promise<string> {
  if (!mode || mode === 'auto') return loginShellPath()
  if (mode === 'inherit') return process.env.PATH ?? ''
  return mode
}

/** A relative path must be resolved now: the child process runs in another folder. */
export const resolveBin = (bin: string): string => (isAbsolute(bin) || !/[\\/]/.test(bin) ? bin : resolve(bin))

const executableNames = (name: string): string[] => {
  if (process.platform !== 'win32' || /\.\w+$/.test(name)) return [name]
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  return [...exts.map((e) => name + e.toLowerCase()), name]
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await fs.access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return (await fs.stat(path)).isFile()
  } catch {
    return false
  }
}

/** The first executable among `names` in `path`, as an absolute path. */
export async function findBinary(names: string[], path: string): Promise<string | null> {
  for (const name of names) {
    if (/[\\/]/.test(name)) {
      if (await isExecutableFile(resolve(name))) return resolve(name)
      continue
    }
    for (const dir of path.split(delimiter)) {
      if (!dir) continue
      for (const file of executableNames(name)) {
        const candidate = join(dir, file)
        if (await isExecutableFile(candidate)) return candidate
      }
    }
  }
  return null
}

/** Environment for a CLI: the search PATH, no colours, nothing leaking from Electron. */
export function childEnv(path: string, extra: Record<string, string> | undefined, strip: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, NO_COLOR: '1' }
  // Started from an Electron app in development, the CLI would inherit it and run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of strip) delete env[key]
  return { ...env, ...extra }
}
