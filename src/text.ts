import { HarnessError } from './errors.js'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Remove ANSI colour codes and zero-width characters some CLIs pad their output with. */
export const stripControl = (text: string): string =>
  text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[​-‍﻿]/g, '')

/** The first line of `--version`, and the version number in it. */
export function parseVersion(stdout: string): { version: string | null; versionText: string | null } {
  const versionText = stripControl(stdout).trim().split('\n')[0]?.trim() || null
  const version = versionText ? (/\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(versionText)?.[0] ?? null) : null
  return { version, versionText }
}

/** Parse every line of `stdout` that is a JSON object; other lines (warnings, retries) are skipped. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  const whole = stdout.trim()
  try {
    const parsed: unknown = JSON.parse(whole)
    if (isRecord(parsed)) return [parsed]
  } catch {
    // one object per line
  }
  const out: Record<string, unknown>[] = []
  for (const line of whole.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(t)
      if (isRecord(parsed)) out.push(parsed)
    } catch {
      // not JSON
    }
  }
  return out
}

/** The `{"type":"result"}` object Claude Code and Cursor print at the end, or the only object. */
export function resultObject(stdout: string): Record<string, unknown> | null {
  const objects = jsonLines(stdout)
  for (let i = objects.length - 1; i >= 0; i--) if (objects[i]?.type === 'result') return objects[i] ?? null
  return objects.length === 1 ? (objects[0] ?? null) : null
}

/** Strip a code fence or `<text>` tags that models sometimes wrap an answer in. */
export function unwrapText(text: string): string {
  let t = text.trim()
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence?.[1] !== undefined && !fence[1].includes('```')) t = fence[1].trim()
  return t.replace(/^<text>\s*/i, '').replace(/\s*<\/text>$/i, '')
}

/**
 * The first JSON value in a model's answer, even inside a code fence or after an
 * introductory sentence ("Looking at the images…").
 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text)
  const candidates = [text.trim(), fence?.[1] ?? '']
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  const firstArr = text.indexOf('[')
  const lastArr = text.lastIndexOf(']')
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(text.slice(firstArr, lastArr + 1))
  for (const c of candidates) {
    if (!c) continue
    try {
      return JSON.parse(c)
    } catch {
      // next candidate
    }
  }
  // Last resort: the first balanced object or array (Cursor sometimes repeats its answer: `{…}{…}`).
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    const end = balancedEnd(text, i)
    if (end < 0) continue
    try {
      return JSON.parse(text.slice(i, end + 1))
    } catch {
      // keep looking
    }
  }
  throw new HarnessError('INVALID_JSON', 'The answer does not contain readable JSON.', { raw: text })
}

/** Index of the bracket closing the one at `start`, skipping strings; -1 if none. */
function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
