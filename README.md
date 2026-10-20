# local-harness

One JavaScript API for the AI agent CLIs already installed and logged in on the machine: **Claude Code**, **Cursor Agent**, **OpenAI Codex**, **Gemini CLI** and **OpenCode**.

- **Discovery**: which CLIs are installed, their version, whether they are logged in, their models, default model and effort, effort levels and fast mode.
- **Interaction**: send a prompt (text and images) to one of them and get the answer back. Model, effort and fast mode are set per call.

Every CLI has its own flags and output format. local-harness hides them behind one API, so you can build AI tools on top of the agent the user already installed and paid for, without API keys of your own and without one integration per tool.

Zero runtime dependencies. Written for Node ≥ 20, Electron (main process), Bun and Deno (see [Tested environments](#tested-environments)). ESM and CommonJS, with TypeScript types.

```sh
npm install local-harness
```

## Quick start

```js
import { getHarnesses, ask } from 'local-harness'

const harnesses = await getHarnesses()
// [{ id: 'claude', name: 'Claude Code', version: '2.1.304', auth: { loggedIn: true, … }, models: […], … },
//  { id: 'cursor', name: 'Cursor Agent', version: '2026.10.18-ea085cb', … }]

const { text } = await ask('claude', 'Write a commit message for this diff: …', {
  model: 'opus',
  effort: 'high'
})
```

## Supported CLIs

| id         | Executable               | Login check                 | Models                                     | Effort            | Fast mode              | Images              | Status       |
| ---------- | ------------------------ | --------------------------- | ------------------------------------------ | ----------------- | ---------------------- | ------------------- | ------------ |
| `claude`   | `claude`                 | `claude auth status`        | aliases (`opus`, `sonnet`, `haiku`, `fable`) + any `claude-*` name | low … max (not Haiku) | Opus only      | in the message      | verified     |
| `cursor`   | `agent`, `cursor-agent`  | `agent status`              | from the CLI, grouped by family            | picks the variant | picks the `-fast` variant | as files         | verified     |
| `codex`    | `codex`                  | `codex login status`        | default + `~/.codex/config.toml`           | minimal … xhigh   | –                      | `--image`           | experimental |
| `gemini`   | `gemini`                 | API key / OAuth file        | default + `~/.gemini/settings.json`        | –                 | –                      | –                   | experimental |
| `opencode` | `opencode`               | `opencode auth list`        | from the CLI (`opencode models`)           | –                 | –                      | –                   | experimental |

"Verified" means the headless flags were tried on a real install; experimental ones follow each CLI's documentation (`verified: false` in the discovery result).

## Tested environments

| OS                    | Runtime      | CLIs                                           | Checked                                   |
| --------------------- | ------------ | ---------------------------------------------- | ----------------------------------------- |
| macOS 27.0.1 (arm64)  | Node 24.16.0 | Claude Code 2.1.304, Cursor Agent 2026.10.18   | unit tests, discovery, text and image prompts |

Other environments are not tested yet.

## Discovery

### `getHarnesses(options?)`

Checks every CLI in parallel. By default returns only the installed ones, with all their metadata.

| Option           | Default  | Effect |
| ---------------- | -------- | ------ |
| `includeMissing` | `false`  | Also return CLIs that are not installed (`installed: false`). |
| `detail`         | `'full'` | `'basic'`: path and version only (one process per CLI). `'full'`: also login, models, defaults. |
| `only`           | all      | Only check these ids. |
| `refresh`        | `false`  | Ignore the cache, model catalogs included. |

Each entry:

```ts
interface Harness {
  id: 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode'
  name: string                 // "Claude Code"
  installed: boolean
  bin: string | null           // absolute path
  version: string | null       // "2.1.304"
  versionText: string | null   // "2.1.304 (Claude Code)"
  verified: boolean
  images: boolean              // prompts can carry images
  auth: { loggedIn: boolean | null; method?: string; loginCommand: string }
  models: ModelInfo[]
  defaultModel: string | null  // from the user's own config; null = the account decides
  defaultEffort: Effort | null
  efforts: Effort[]
  fast: boolean
  customModels: boolean        // model names outside the catalog are accepted
  modelsSource: 'cli' | 'catalog'
}

interface ModelInfo {
  id: string                   // the value for ask({ model }); "" = default
  label: string
  efforts: Effort[]            // empty = no choice
  fast: boolean
  isDefault?: boolean
  variants?: { id: string; label: string; effort: Effort | null; fast: boolean }[]  // Cursor
}
```

### `getHarness(id, options?)`

The same check for one CLI. Always resolves, installed or not.

### `getModels(id, { refresh? })`

Only the model catalog. Cursor's and OpenCode's come from the CLI and are cached for 10 minutes; they reject with `NOT_INSTALLED` when the CLI is missing. The built-in catalogs (Claude Code, Codex, Gemini) are returned even without the CLI.

## Interaction

### `ask(id, prompt, options?)`

```ts
ask(id: HarnessId, prompt: string | PromptPart[], options?: AskOptions): Promise<AskResult>
```

The CLI runs headless, without tools and read-only. The prompt goes through stdin.

| Option       | Default | Effect |
| ------------ | ------- | ------ |
| `system`     | –       | System prompt. Claude Code: replaces its "coding agent" prompt. Others: put at the top of the message. |
| `model`      | the CLI's default | A model `id` from the catalog, or any name the CLI accepts. For Cursor, a family or a concrete variant id. |
| `effort`     | the CLI's default | Ignored when the model does not offer it (see `applied`), unless `strict`. |
| `fast`       | off     | Off unless `true`. Where the model has fast mode, "off" is told to the CLI explicitly, overriding the user's settings. |
| `cwd`        | a new empty temporary folder | Where the CLI runs. Each request gets its own folder, removed afterwards. |
| `isolation`  | `'project'` with `cwd`, else `'clean'` | `'clean'` makes Claude Code ignore CLAUDE.md, skills, hooks and MCP servers. |
| `signal`     | –       | `AbortSignal`; rejects with `ABORTED`. |
| `requestId`  | –       | Lets `cancel(requestId)` stop the request. A new request with the same id cancels the running one. |
| `timeoutMs`  | 180 000 | Rejects with `TIMEOUT`. |
| `env`        | –       | Extra environment variables for the CLI. |
| `unwrap`     | `false` | Strip a code fence or `<text>` tags around the answer. |
| `strict`     | `false` | Reject with `UNSUPPORTED_OPTION` instead of ignoring an effort or fast mode the model lacks. |
| `imageHint`  | English sentence | For CLIs that read images from files (Cursor): the sentence that tells the agent to look at them. |
| `imageListLabel` | `'Images'` | For the same CLIs: the word before the list of image names (`Images: a.jpg, b.jpg`). |
| `skipUnreadableImages` | `false` | Leave out images that cannot be read or are not JPEG, PNG, GIF or WebP, instead of rejecting with `UNSUPPORTED_INPUT`. They are listed in `skippedImages`. |

```ts
interface AskResult {
  text: string
  harness: HarnessId
  model: string | null         // the model that answered, when the CLI says
  durationMs: number           // measured, CLI start-up included
  cliDurationMs: number | null // as reported by the CLI
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  sessionId?: string
  skippedImages?: string[]     // with skipUnreadableImages
  applied: { model: string | null; effort: Effort | null; fast: boolean | null }  // what the CLI actually got
  args: string[]
  raw: string
}
```

### Images

Pass a list of parts instead of a string: text and images in the order the model should read them. `name` is how the text refers to the image. Consecutive text parts are separated by a blank line.

```js
const { text } = await ask('claude', [
  { type: 'text', text: 'Event 1: 12–14 August, Matera. Suggest a folder name.' },
  { type: 'image', path: '/tmp/thumbs/1-a.jpg', name: '1-a.jpg' },
  { type: 'image', path: '/tmp/thumbs/1-b.jpg', name: '1-b.jpg' }
], { system: 'Reply with a JSON object only.' })
```

Claude Code receives the images inside the message (base64, type read from the file's bytes). Cursor has no image input: they are copied, under their `name`, into a folder that holds only them, and the message lists them. A CLI without image support rejects with `UNSUPPORTED_INPUT`.

### `cancel(requestId)`

Stops a request started with `requestId`. Returns `false` if it was not running.

## Configuration

The top-level functions use a default client. Create your own for different settings; it has the same methods.

```js
import { createClient } from 'local-harness'

const client = createClient({
  bins: { claude: './dev/fake-cli.js' },   // executable overrides (relative paths are resolved now)
  path: 'auto',                            // 'auto' | 'inherit' | a PATH string
  timeoutMs: 180_000,
  keepApiKeys: false,
  cacheTtlMs: { discovery: 60_000, models: 600_000 },
  harnesses: ['claude', 'cursor']
})
```

- `path: 'auto'` merges the process PATH, the login shell's PATH and the usual install folders (`~/.local/bin`, Homebrew). Apps started from the macOS Finder get a minimal PATH that would miss them.
- Unless `keepApiKeys` is set, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from Claude Code's environment: with them it bills per use instead of using the subscription. `ELECTRON_RUN_AS_NODE` is always removed.
- When a CLI refuses a recent flag (`unknown option`), the request is retried without the optional flags.

## Errors

Everything throws `HarnessError`, with a stable `code`, an English `message`, the CLI's own output in `raw`, plus `harness` and `exitCode`. Translate by `code` if your app speaks another language.

| code                 | When |
| -------------------- | ---- |
| `UNKNOWN_HARNESS`    | Unknown id. |
| `NOT_INSTALLED`      | Executable not found. |
| `NOT_LOGGED_IN`      | The CLI says there is no valid login. |
| `USAGE_LIMIT`        | Usage, rate or quota limit reached. |
| `UNKNOWN_MODEL`      | The CLI does not know the model. |
| `UNSUPPORTED_OPTION` | With `strict`: effort or fast mode not available for the model. |
| `UNSUPPORTED_INPUT`  | Images for a CLI that does not take them, or an unreadable image. |
| `TIMEOUT`            | No answer within `timeoutMs`. |
| `ABORTED`            | Cancelled by `signal` or `cancel()`. |
| `INVALID_JSON`       | From `extractJson()`: no readable JSON in the text. |
| `CLI_ERROR`          | Anything else; details in `raw`. |

## Utilities

| Export | |
| ------ | - |
| `HARNESS_IDS`, `isHarnessId(v)` | The supported ids. |
| `isEffort(v, id?)` | Whether `v` is an effort level (one that CLI accepts, when given). |
| `acceptsModel(id, v)` | Whether a model name is acceptable for a CLI. For Claude Code: `claude-…` names and its aliases (`opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default`, also with `[1m]`); for the others, by syntax alone. |
| `resolveArgs(id, prompt?, options?)` | The arguments `ask()` would pass, without running the CLI. |
| `extractJson(text)` | The first JSON value in an answer, even inside a code fence, after a sentence, or repeated. |
| `unwrapText(text)` | What `unwrap: true` does. |
| `loginShellPath()`, `setLoginShellPath(path)` | The login shell's PATH (computed once), or a fixed one for tests. |
| `clearCache()` | Forget cached discovery results and catalogs. |

## Known quirks

- Cursor Agent sometimes loses its connection and reconnects; after a reconnect it can repeat its answer (`"pongpong"`). `extractJson()` copes with a repeated JSON object.
- Claude Code has no command that lists models: the catalog has only the aliases, which follow the latest version of each family. Full names (`claude-…`) are accepted as custom models.

## Development

```sh
npm test            # unit tests, against fake CLIs
npm run build
npm run smoke       # against the CLIs installed here (spends a few tokens)
```

## License

MIT
