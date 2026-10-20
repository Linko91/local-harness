import type { HarnessId } from '../types.js'
import type { Adapter } from './adapter.js'
import { claude } from './claude.js'
import { codex } from './codex.js'
import { cursor } from './cursor.js'
import { gemini } from './gemini.js'
import { opencode } from './opencode.js'

export const ADAPTERS: Record<HarnessId, Adapter> = { claude, cursor, codex, gemini, opencode }

export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'cursor', 'codex', 'gemini', 'opencode']

export const isHarnessId = (value: unknown): value is HarnessId =>
  typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
