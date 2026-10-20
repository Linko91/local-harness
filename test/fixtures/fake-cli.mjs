// A fake agent CLI for the tests. The first argument says which one it pretends to be.
// Every run is appended to $FAKE_LOG as one JSON line: arguments, stdin, cwd, files, environment.
//
// Behaviour switches (environment):
//   FAKE_RESULT      the answer text
//   FAKE_ERROR       answer with this error instead
//   FAKE_REJECT_FLAG refuse this flag as unknown
//   FAKE_DELAY_MS    wait before answering
//   FAKE_LOGGED_IN   "0" = not logged in

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const [kind, ...args] = process.argv.slice(2)
const env = process.env
const here = dirname(fileURLToPath(import.meta.url))

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')
const has = (flag) => args.includes(flag)
const after = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

const stdin = args.includes('--version') ? '' : readStdin()
const cwd = process.cwd()
// Only the request's own folder: the system temp folder changes under parallel tests.
const listFiles = (dir) => {
  if (!/local-harness-|lh-proj-/.test(dir)) return []
  return readdirSync(dir).map((f) => ({ name: f, size: statSync(join(dir, f)).size }))
}
const files = listFiles(cwd)
const extraDirs = args.flatMap((a, i) => (args[i - 1] === '--add-dir' ? [{ dir: a, files: readdirSync(a) }] : []))
if (env.FAKE_LOG) {
  appendFileSync(
    env.FAKE_LOG,
    JSON.stringify({
      kind,
      args,
      stdin,
      cwd,
      files,
      extraDirs,
      systemFile: after('--system-prompt-file') ? readFileSync(after('--system-prompt-file'), 'utf8') : null,
      env: {
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? null,
        ELECTRON_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE ?? null,
        NO_COLOR: env.NO_COLOR ?? null,
        FAKE_EXTRA: env.FAKE_EXTRA ?? null
      }
    }) + '\n'
  )
}

if (env.FAKE_REJECT_FLAG && args.includes(env.FAKE_REJECT_FLAG)) {
  process.stderr.write(`error: unknown option '${env.FAKE_REJECT_FLAG}'\n`)
  process.exit(1)
}

const VERSIONS = {
  claude: '2.1.303 (Claude Code)',
  cursor: '2026.10.16-e3cb207',
  codex: 'codex-cli 0.98.0',
  gemini: '0.40.1',
  opencode: '1.2.3'
}
if (has('--version')) {
  out(VERSIONS[kind])
  process.exit(0)
}

const loggedIn = env.FAKE_LOGGED_IN !== '0'
if (env.FAKE_DELAY_MS) await sleep(Number(env.FAKE_DELAY_MS))
const answer = env.FAKE_RESULT ?? `echo: ${stdin.slice(0, 40)}`

switch (kind) {
  case 'claude': {
    if (args[0] === 'auth') {
      out(JSON.stringify({ loggedIn, authMethod: 'claude.ai' }, null, 2))
      process.exit(loggedIn ? 0 : 1)
    }
    const stream = after('--output-format') === 'stream-json'
    const model = after('--model') === 'haiku' ? 'claude-haiku-5-5' : 'claude-opus-5-5'
    const result = env.FAKE_ERROR
      ? { type: 'result', subtype: 'error', is_error: true, result: env.FAKE_ERROR }
      : {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: answer,
          duration_ms: 1234,
          session_id: 'sess-1',
          total_cost_usd: 0.01,
          usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 5, output_tokens: 3 },
          modelUsage: { 'claude-side-model': { outputTokens: 1 }, [model]: { outputTokens: 3 } }
        }
    if (stream) {
      out(JSON.stringify({ type: 'system', subtype: 'init', model }))
      out(JSON.stringify({ type: 'assistant', message: {} }))
      out(JSON.stringify(result))
    } else out(JSON.stringify(result))
    process.exit(env.FAKE_ERROR ? 1 : 0)
  }
  case 'cursor': {
    if (args[0] === 'status') {
      out(JSON.stringify({ status: loggedIn ? 'authenticated' : 'unauthenticated', isAuthenticated: loggedIn }))
      process.exit(0)
    }
    if (args[0] === 'models' || has('--list-models')) {
      process.stdout.write(readFileSync(join(here, 'cursor-models.txt'), 'utf8'))
      process.exit(0)
    }
    out('Connection lost, reconnecting (attempt 1)...')
    if (env.FAKE_ERROR) {
      out(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: env.FAKE_ERROR }))
      process.exit(1)
    }
    out(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900, result: answer, session_id: 'c-1', usage: { inputTokens: 7, outputTokens: 2 } }))
    process.exit(0)
  }
  case 'codex': {
    if (args[0] === 'login') {
      out(loggedIn ? 'Logged in using ChatGPT' : 'Not logged in')
      process.exit(loggedIn ? 0 : 1)
    }
    out(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }))
    if (env.FAKE_ERROR) {
      out(JSON.stringify({ type: 'turn.failed', error: { message: env.FAKE_ERROR } }))
      process.exit(1)
    }
    out(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } }))
    out(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: answer } }))
    out(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 4 } }))
    process.exit(0)
  }
  case 'gemini': {
    if (env.FAKE_ERROR) {
      out(JSON.stringify({ error: { type: 'Error', message: env.FAKE_ERROR } }))
      process.exit(1)
    }
    if (after('--output-format') === 'json') out(JSON.stringify({ response: answer, stats: { models: { 'gemini-3-pro': {} } } }))
    else out(answer)
    process.exit(0)
  }
  case 'opencode': {
    if (args[0] === 'auth') {
      out(`Credentials ~/.local/share/opencode/auth.json\n● Anthropic oauth\n└ ${loggedIn ? 1 : 0} credentials`)
      process.exit(0)
    }
    if (args[0] === 'models') {
      out('anthropic/claude-sonnet-5\nopenai/gpt-5.3\n')
      process.exit(0)
    }
    if (env.FAKE_ERROR) {
      process.stderr.write(env.FAKE_ERROR + '\n')
      process.exit(1)
    }
    out(answer)
    process.exit(0)
  }
  default:
    process.stderr.write(`unknown fake kind ${kind}\n`)
    process.exit(2)
}
