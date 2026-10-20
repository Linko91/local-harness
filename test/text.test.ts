import { describe, expect, it } from 'vitest'
import { HarnessError, acceptsModel, extractJson, isEffort, isHarnessId, unwrapText } from '../src/index.js'
import { classifyError } from '../src/errors.js'
import { mediaTypeOf, partsToText } from '../src/images.js'
import { parseVersion, resultObject } from '../src/text.js'

describe('parseVersion', () => {
  it('keeps the first line and finds the number', () => {
    expect(parseVersion('2.1.303 (Claude Code)\n')).toEqual({ version: '2.1.303', versionText: '2.1.303 (Claude Code)' })
    expect(parseVersion('2026.10.16-e3cb207')).toEqual({ version: '2026.10.16-e3cb207', versionText: '2026.10.16-e3cb207' })
    expect(parseVersion('codex-cli 0.98.0\nmore')).toEqual({ version: '0.98.0', versionText: 'codex-cli 0.98.0' })
    expect(parseVersion('')).toEqual({ version: null, versionText: null })
  })
})

describe('resultObject', () => {
  it('takes the last result line among warnings and events', () => {
    const out = 'Connection lost\n{"type":"system"}\n{"type":"result","result":"a"}\n{"type":"result","result":"b"}\n'
    expect(resultObject(out)?.result).toBe('b')
  })
  it('accepts a single pretty-printed object', () => {
    expect(resultObject('{\n  "result": "x"\n}')?.result).toBe('x')
  })
  it('returns null without JSON', () => {
    expect(resultObject('plain text')).toBeNull()
  })
})

describe('unwrapText', () => {
  it('strips a code fence and <text> tags', () => {
    expect(unwrapText('```\nhello\n```')).toBe('hello')
    expect(unwrapText('```markdown\nhello\n```')).toBe('hello')
    expect(unwrapText('<text>\nhello\n</text>')).toBe('hello')
    expect(unwrapText('```a```b```')).toBe('```a```b```')
  })
})

describe('extractJson', () => {
  it('finds JSON in fences, after a sentence, or bare', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('Here it is:\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(extractJson('Looking at the images… {"colore":"rosso"} done')).toEqual({ colore: 'rosso' })
    expect(extractJson('list: [1,2]')).toEqual([1, 2])
  })
  it('takes the first object when the answer repeats it', () => {
    expect(extractJson('Opening `prova.png`.{"colour":"red"}{"colour":"red"}')).toEqual({ colour: 'red' })
    expect(extractJson('{"a":"}{"}{"a":"x"}')).toEqual({ a: '}{' })
  })
  it('throws INVALID_JSON otherwise', () => {
    expect(() => extractJson('nothing here')).toThrow(HarnessError)
    try {
      extractJson('nope')
    } catch (err) {
      expect((err as HarnessError).code).toBe('INVALID_JSON')
    }
  })
})

describe('classifyError', () => {
  it('sorts CLI errors', () => {
    expect(classifyError('Error: not logged in')).toBe('NOT_LOGGED_IN')
    expect(classifyError('401 Unauthorized')).toBe('NOT_LOGGED_IN')
    expect(classifyError('You have reached your usage limit')).toBe('USAGE_LIMIT')
    expect(classifyError('Rate limit exceeded')).toBe('USAGE_LIMIT')
    expect(classifyError('model foo not found')).toBe('UNKNOWN_MODEL')
    expect(classifyError("There's an issue with the selected model (x). It may not exist or you may not have access to it.")).toBe(
      'UNKNOWN_MODEL'
    )
    expect(classifyError('segfault')).toBe('CLI_ERROR')
  })
})

describe('validators', () => {
  it('isEffort, per harness', () => {
    expect(isEffort('high')).toBe(true)
    expect(isEffort('')).toBe(false)
    expect(isEffort('max', 'claude')).toBe(true)
    expect(isEffort('minimal', 'claude')).toBe(false)
    expect(isEffort('minimal', 'codex')).toBe(true)
    expect(isEffort('max', 'codex')).toBe(false)
    expect(isEffort('high', 'gemini')).toBe(false)
  })
  it('acceptsModel', () => {
    expect(acceptsModel('claude', '')).toBe(true)
    expect(acceptsModel('claude', 'opus')).toBe(true)
    expect(acceptsModel('claude', 'claude-sonnet-4-6')).toBe(true)
    expect(acceptsModel('claude', 'sonnet[1m]')).toBe(true)
    expect(acceptsModel('claude', 'opusplan')).toBe(true)
    expect(acceptsModel('claude', 'default')).toBe(true)
    expect(acceptsModel('claude', 'gpt-9')).toBe(false)
    expect(acceptsModel('claude', 'rm -rf /')).toBe(false)
    expect(acceptsModel('claude', 42)).toBe(false)
    expect(acceptsModel('cursor', 'claude-opus-5-thinking-high-fast')).toBe(true)
    expect(acceptsModel('cursor', 'bad name')).toBe(false)
  })
  it('isHarnessId', () => {
    expect(isHarnessId('cursor')).toBe(true)
    expect(isHarnessId('copilot')).toBe(false)
  })
})

describe('images', () => {
  it('reads the media type from the bytes', () => {
    expect(mediaTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(mediaTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(mediaTypeOf(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(mediaTypeOf(Buffer.from('RIFF\0\0\0\0WEBP'))).toBe('image/webp')
    expect(mediaTypeOf(Buffer.from('hello'))).toBeNull()
  })
  it('lists image names after their text block', () => {
    const img = (name: string) => ({ type: 'image' as const, name, path: name, mediaType: 'image/png' as const, data: Buffer.alloc(0) })
    expect(
      partsToText([{ type: 'text', text: 'intro' }, { type: 'text', text: 'Event 1' }, img('1-a.jpg'), img('1-b.jpg'), { type: 'text', text: 'Event 2' }])
    ).toBe('intro\n\nEvent 1\nImages: 1-a.jpg, 1-b.jpg\n\nEvent 2')
  })
})
