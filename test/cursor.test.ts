import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cursorCatalog, parseCursorModels, pickVariant } from '../src/harnesses/cursor.js'

const listing = readFileSync(join(import.meta.dirname, 'fixtures/cursor-models.txt'), 'utf8')

describe('Cursor model list', () => {
  const variants = parseCursorModels(listing)

  it('reads every model line of the real output, and nothing else', () => {
    expect(variants.length).toBe(265)
    expect(variants.some((v) => /^(available|tip)/i.test(v.id))).toBe(false)
    expect(variants.find((v) => v.id === 'gpt-5.3-codex-high-fast')).toEqual({
      id: 'gpt-5.3-codex-high-fast',
      label: 'Codex 5.3 High Fast',
      family: 'gpt-5.3-codex',
      effort: 'high',
      fast: true,
      marked: false
    })
  })

  it('removes zero-width padding and ANSI codes', () => {
    const v = parseCursorModels('\u001b[1mgrok-4.7-low-fast\u001b[0m - Grok 4.7  Low Fast​​\n')
    expect(v[0]).toMatchObject({ id: 'grok-4.7-low-fast', label: 'Grok 4.7  Low Fast' })
  })

  it('accepts "id (Label)" and bare ids, and notes the default', () => {
    const v = parseCursorModels('Available models:\n  auto - Auto (default)\n  fake-1 (Fake one)\n  fake-2\nTip: switch with --model')
    expect(v.map((x) => [x.id, x.label, x.marked])).toEqual([
      ['auto', 'Auto', true],
      ['fake-1', 'Fake one', false],
      ['fake-2', 'fake-2', false]
    ])
  })

  it('groups variants into families with their efforts and fast mode', () => {
    const catalog = cursorCatalog(variants)
    expect(catalog.models[0]).toMatchObject({ id: '', label: 'Auto', isDefault: true })
    expect(catalog.models.some((m) => m.id === 'auto')).toBe(false)
    const codex = catalog.models.find((m) => m.id === 'gpt-5.3-codex')
    expect(codex).toMatchObject({ label: 'Codex 5.3', efforts: ['low', 'high', 'xhigh'], fast: true })
    expect(codex?.variants?.map((v) => v.id)).toContain('gpt-5.3-codex-xhigh-fast')
    // A single fixed effort is not a choice.
    expect(catalog.models.find((m) => m.id === 'gpt-5.5-extra')).toMatchObject({ efforts: [], fast: true })
    expect(catalog.models.find((m) => m.id === 'claude-opus-5-thinking')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(catalog.source).toBe('cli')
  })

  it('picks the variant for an effort and a speed, or the nearest', () => {
    const codex = cursorCatalog(variants).models.find((m) => m.id === 'gpt-5.3-codex')?.variants ?? []
    expect(pickVariant(codex, 'high', true)?.id).toBe('gpt-5.3-codex-high-fast')
    expect(pickVariant(codex, 'high', false)?.id).toBe('gpt-5.3-codex-high')
    expect(pickVariant(codex, null, false)?.id).toBe('gpt-5.3-codex')
    expect(pickVariant(codex, 'max', false)?.id).toBe('gpt-5.3-codex')
  })
})
