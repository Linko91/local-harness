import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { HarnessError } from './errors.js'
import type { HarnessId, PromptPart } from './types.js'

export type MediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/** The image type from the file's first bytes, whatever its extension says. */
export function mediaTypeOf(bytes: Uint8Array): MediaType | null {
  const b = bytes
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp'
  return null
}

export interface LoadedImage {
  name: string
  path: string
  mediaType: MediaType
  data: Buffer
}

export type LoadedPart = { type: 'text'; text: string } | ({ type: 'image' } & LoadedImage)

/**
 * A prompt as parts, with every image read and checked. With `skipUnreadable`, an
 * image that cannot be used is left out and its path listed in `skipped`.
 */
export async function loadParts(
  prompt: string | PromptPart[],
  harness: HarnessId,
  skipUnreadable = false
): Promise<{ parts: LoadedPart[]; skipped: string[] }> {
  if (typeof prompt === 'string') return { parts: [{ type: 'text', text: prompt }], skipped: [] }
  const parts: LoadedPart[] = []
  const skipped: string[] = []
  for (const part of prompt) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    let data: Buffer
    try {
      data = await fs.readFile(part.path)
    } catch (err) {
      if (skipUnreadable) {
        skipped.push(part.path)
        continue
      }
      throw new HarnessError('UNSUPPORTED_INPUT', `Cannot read the image ${part.path}.`, { harness, cause: err })
    }
    const mediaType = mediaTypeOf(data)
    if (!mediaType) {
      if (skipUnreadable) {
        skipped.push(part.path)
        continue
      }
      throw new HarnessError('UNSUPPORTED_INPUT', `${part.path} is not a JPEG, PNG, GIF or WebP image.`, { harness })
    }
    parts.push({ type: 'image', name: part.name || basename(part.path), path: part.path, mediaType, data })
  }
  return { parts, skipped }
}

export const hasImages = (parts: LoadedPart[]): boolean => parts.some((p) => p.type === 'image')

export const DEFAULT_IMAGE_HINT = 'The images mentioned are files in this folder: look at all of them before answering.'
export const DEFAULT_IMAGE_LIST_LABEL = 'Images'

/**
 * The prompt as plain text, for harnesses that read images from files: after
 * each block of text, the names of the images that belong to it.
 */
export function partsToText(parts: LoadedPart[], label = DEFAULT_IMAGE_LIST_LABEL): string {
  const blocks: { text: string; images: string[] }[] = []
  for (const p of parts) {
    if (p.type === 'text') blocks.push({ text: p.text, images: [] })
    else if (blocks.length) blocks[blocks.length - 1]?.images.push(p.name)
    else blocks.push({ text: '', images: [p.name] })
  }
  return blocks
    .map((b) => (b.images.length ? `${b.text}${b.text ? '\n' : ''}${label}: ${b.images.join(', ')}` : b.text))
    .join('\n\n')
}
