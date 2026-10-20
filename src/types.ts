/** The agent CLIs this library knows how to drive. */
export type HarnessId = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode'

/** Reasoning effort levels, from the cheapest to the most thorough. */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A concrete model id for harnesses that encode effort and speed in the name (Cursor). */
export interface ModelVariant {
  id: string
  label: string
  effort: Effort | null
  fast: boolean
}

/** A model a harness can run, with the effort levels and fast mode it offers. */
export interface ModelInfo {
  /** The value for `ask({ model })`; `""` is the harness's own default. */
  id: string
  label: string
  /** Empty when the model offers no choice. */
  efforts: Effort[]
  fast: boolean
  isDefault?: boolean
  /** Only for harnesses that encode effort and fast mode in the model id (Cursor). */
  variants?: ModelVariant[]
}

/** The models a harness offers. */
export interface ModelCatalog {
  models: ModelInfo[]
  /** Whether model names outside the catalog are accepted. */
  custom: boolean
  /** The default from the user's own configuration; `null` leaves it to the account. */
  defaultModel: string | null
  source: 'cli' | 'catalog'
}

export interface AuthInfo {
  /** `null` when the CLI cannot tell. */
  loggedIn: boolean | null
  /** "claude.ai", "chatgpt", "api-key"… when the CLI says. */
  method?: string
  /** The command to run in a terminal to log in. */
  loginCommand: string
}

/** An agent CLI found (or not) on this machine. */
export interface Harness {
  id: HarnessId
  /** "Claude Code", "Cursor Agent", "OpenAI Codex"… */
  name: string
  installed: boolean
  /** Absolute path of the executable; `null` when not found. */
  bin: string | null
  /** Just the version number, e.g. "2.1.303". */
  version: string | null
  /** The first line of `--version`, e.g. "2.1.303 (Claude Code)". */
  versionText: string | null
  /** Whether the headless flags were tried on a real install. */
  verified: boolean
  /** Whether prompts can carry images. */
  images: boolean
  auth: AuthInfo
  /** Empty with `detail: 'basic'`. */
  models: ModelInfo[]
  defaultModel: string | null
  defaultEffort: Effort | null
  /** Union of the efforts the models offer. */
  efforts: Effort[]
  /** Whether at least one model has a fast mode. */
  fast: boolean
  /** Whether model names outside the catalog are accepted. */
  customModels: boolean
  modelsSource: 'cli' | 'catalog'
}

export interface DiscoveryOptions {
  /** Also return harnesses that are not installed. Default `false`. */
  includeMissing?: boolean | undefined
  /** `basic`: path and version only. `full` (default): also login, models and defaults. */
  detail?: 'basic' | 'full' | undefined
  /** Only check these harnesses. */
  only?: HarnessId[] | undefined
  /** Ignore cached results. */
  refresh?: boolean | undefined
}

/** A piece of a prompt: text, or an image the text refers to. */
export type PromptPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      /** Path of the image file (JPEG, PNG, GIF or WebP). */
      path: string
      /** The name the text uses for it; defaults to the file name. */
      name?: string | undefined
    }

export interface AskOptions {
  /** System prompt. */
  system?: string | undefined
  /** A model id from `getModels()`, or any name the harness accepts. Default: the harness's default. */
  model?: string | undefined
  effort?: Effort | undefined
  /** Off unless `true`. `false` explicitly tells the CLI to turn it off. */
  fast?: boolean | undefined
  /** Where the CLI runs. Default: a new empty temporary folder, removed afterwards. */
  cwd?: string | undefined
  /** `clean` ignores project config (CLAUDE.md, hooks, MCP…); `project` loads it. Default: `project` with `cwd`, else `clean`. */
  isolation?: 'clean' | 'project' | undefined
  signal?: AbortSignal | undefined
  /** Register the request for `cancel(requestId)`. A new request with the same id cancels the running one. */
  requestId?: string | undefined
  /** Default 180 000. */
  timeoutMs?: number | undefined
  /** Extra environment variables for the CLI. */
  env?: Record<string, string> | undefined
  /** Strip a code fence or `<text>` tags wrapped around the answer. */
  unwrap?: boolean | undefined
  /** Fail with `UNSUPPORTED_OPTION` instead of ignoring an effort or fast mode the model lacks. */
  strict?: boolean | undefined
  /** For harnesses that read images from files (Cursor): the sentence that tells the agent to look at them. */
  imageHint?: string | undefined
  /** For harnesses that read images from files: the word before the list of image names. Default `"Images"`. */
  imageListLabel?: string | undefined
  /** Leave out images that cannot be read or are not JPEG, PNG, GIF or WebP, instead of failing with `UNSUPPORTED_INPUT`. They are listed in `skippedImages`. */
  skipUnreadableImages?: boolean | undefined
}

export interface AskResult {
  text: string
  harness: HarnessId
  /** The model that answered, when the CLI reports it. */
  model: string | null
  /** Measured by the library, CLI start-up included. */
  durationMs: number
  /** As reported by the CLI, or `null`. */
  cliDurationMs: number | null
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  sessionId?: string
  /** With `skipUnreadableImages`: the paths of the images left out. */
  skippedImages?: string[]
  /** What was actually passed to the CLI; `null` means "not passed". */
  applied: { model: string | null; effort: Effort | null; fast: boolean | null }
  args: string[]
  raw: string
}

export interface ClientConfig {
  /** Executable to use instead of searching the PATH. Relative paths are resolved immediately. */
  bins?: Partial<Record<HarnessId, string>> | undefined
  /** `auto` (default): process PATH + login shell PATH + common folders. `inherit`: process PATH only. Or a PATH string. */
  path?: 'auto' | 'inherit' | (string & {}) | undefined
  /** Default timeout of `ask()`. Default 180 000. */
  timeoutMs?: number | undefined
  /** Keep `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` for Claude Code (pay-as-you-go billing). Default `false`. */
  keepApiKeys?: boolean | undefined
  /** How long discovery results (default 60 s) and model catalogs (default 10 min) are remembered. */
  cacheTtlMs?: { discovery?: number | undefined; models?: number | undefined } | undefined
  /** The harnesses this client knows. Default: all. */
  harnesses?: HarnessId[] | undefined
}

export interface HarnessClient {
  getHarnesses(options?: DiscoveryOptions): Promise<Harness[]>
  getHarness(id: HarnessId, options?: Omit<DiscoveryOptions, 'only' | 'includeMissing'>): Promise<Harness>
  getModels(id: HarnessId, options?: { refresh?: boolean | undefined }): Promise<ModelCatalog>
  ask(id: HarnessId, prompt: string | PromptPart[], options?: AskOptions): Promise<AskResult>
  cancel(requestId: string): boolean
  resolveArgs(id: HarnessId, prompt?: string | PromptPart[], options?: AskOptions): Promise<string[]>
  clearCache(): void
}
