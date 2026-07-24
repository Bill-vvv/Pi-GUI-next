import { open, readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { nativeImage } from 'electron'

import type {
  KernelPromptAttachment,
  KernelPromptImage
} from '../../shared/kernel-contract.ts'

const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024
const IMAGE_DETECTION_BYTES = 64 * 1024

export async function readPromptAttachments(
  filePaths: readonly string[]
): Promise<KernelPromptAttachment[]> {
  const attachments: KernelPromptAttachment[] = []
  for (const path of filePaths) {
    const fileStat = await stat(path)
    if (fileStat.size === 0) continue
    const detected = detectImage(await readFileHead(path, fileStat.size))
    if (detected.kind === 'unsupported-image') {
      throw new Error(`Unsupported image file: ${path}`)
    }
    if (detected.kind === 'image') {
      const bytes = await readFile(path)
      const fullDetection = detectImage(bytes)
      if (fullDetection.kind !== 'image') {
        throw new Error(`Unsupported image file: ${path}`)
      }
      const processed = processImage(bytes, fullDetection.mimeType, path)
      attachments.push({
        type: 'image',
        name: basename(path),
        path,
        image: processed.image,
        hints: processed.hints
      })
      continue
    }
    attachments.push({
      type: 'file',
      name: basename(path),
      path
    })
  }
  return attachments
}

async function readFileHead(path: string, size: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, IMAGE_DETECTION_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function processImage(
  bytes: Buffer,
  mimeType: SupportedImageMimeType,
  path: string
): { image: KernelPromptImage; hints: string[] } {
  const decoded = nativeImage.createFromBuffer(bytes)
  if (decoded.isEmpty()) throw new Error(`Could not decode image file: ${path}`)
  const original = decoded.getSize()
  if (original.width <= 0 || original.height <= 0) {
    throw new Error(`Image has invalid dimensions: ${path}`)
  }
  const canKeepOriginal = mimeType !== 'image/bmp' &&
    original.width <= MAX_WIDTH &&
    original.height <= MAX_HEIGHT &&
    base64Size(bytes) < MAX_BASE64_BYTES
  if (canKeepOriginal) {
    return {
      image: { type: 'image', mimeType, data: bytes.toString('base64') },
      hints: []
    }
  }

  let width = original.width
  let height = original.height
  if (width > MAX_WIDTH) {
    height = Math.round((height * MAX_WIDTH) / width)
    width = MAX_WIDTH
  }
  if (height > MAX_HEIGHT) {
    width = Math.round((width * MAX_HEIGHT) / height)
    height = MAX_HEIGHT
  }

  while (true) {
    const resized = width === original.width && height === original.height
      ? decoded
      : decoded.resize({ width, height, quality: 'best' })
    if (resized.isEmpty()) throw new Error(`Could not resize image file: ${path}`)
    const candidates: Array<{ bytes: Buffer; mimeType: 'image/png' | 'image/jpeg' }> = [
      { bytes: resized.toPNG(), mimeType: 'image/png' },
      ...[80, 85, 70, 55, 40].map((quality) => ({
        bytes: resized.toJPEG(quality),
        mimeType: 'image/jpeg' as const
      }))
    ]
    const candidate = candidates.find(({ bytes: output }) =>
      output.length > 0 && base64Size(output) < MAX_BASE64_BYTES
    )
    if (candidate !== undefined) {
      const hints: string[] = []
      if (mimeType === 'image/bmp') {
        hints.push(`[Image converted from image/bmp to ${candidate.mimeType}.]`)
      }
      if (width !== original.width || height !== original.height) {
        const scale = original.width / width
        hints.push(
          `[Image: original ${original.width}x${original.height}, displayed at ` +
          `${width}x${height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`
        )
      }
      return {
        image: {
          type: 'image',
          mimeType: candidate.mimeType,
          data: candidate.bytes.toString('base64')
        },
        hints
      }
    }
    if (width === 1 && height === 1) break
    width = width === 1 ? 1 : Math.max(1, Math.floor(width * 0.75))
    height = height === 1 ? 1 : Math.max(1, Math.floor(height * 0.75))
  }
  throw new Error(`Could not resize image below the inline size limit: ${path}`)
}

type SupportedImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/bmp'

type ImageDetection =
  | { kind: 'image'; mimeType: SupportedImageMimeType }
  | { kind: 'unsupported-image' }
  | { kind: 'not-image' }

function detectImage(buffer: Buffer): ImageDetection {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7
      ? { kind: 'unsupported-image' }
      : { kind: 'image', mimeType: 'image/jpeg' }
  }
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (!isPng(buffer) || isAnimatedPng(buffer)) return { kind: 'unsupported-image' }
    return { kind: 'image', mimeType: 'image/png' }
  }
  if (startsWithAscii(buffer, 0, 'GIF')) return { kind: 'image', mimeType: 'image/gif' }
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) {
    return { kind: 'image', mimeType: 'image/webp' }
  }
  if (startsWithAscii(buffer, 0, 'BM')) {
    return isBmp(buffer)
      ? { kind: 'image', mimeType: 'image/bmp' }
      : { kind: 'unsupported-image' }
  }
  return { kind: 'not-image' }
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 16 &&
    buffer.readUInt32BE(8) === 13 &&
    startsWithAscii(buffer, 12, 'IHDR')
}

function isAnimatedPng(buffer: Buffer): boolean {
  let offset = 8
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset)
    const chunkTypeOffset = offset + 4
    if (startsWithAscii(buffer, chunkTypeOffset, 'acTL')) return true
    if (startsWithAscii(buffer, chunkTypeOffset, 'IDAT')) return false
    const nextOffset = offset + 8 + chunkLength + 4
    if (nextOffset <= offset || nextOffset > buffer.length) return false
    offset = nextOffset
  }
  return false
}

function isBmp(buffer: Buffer): boolean {
  if (buffer.length < 30) return false
  const declaredFileSize = buffer.readUInt32LE(2)
  const pixelDataOffset = buffer.readUInt32LE(10)
  const dibHeaderSize = buffer.readUInt32LE(14)
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false
  if (pixelDataOffset < 14 + dibHeaderSize) return false
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false
  const colorPlanes = dibHeaderSize === 12 ? buffer.readUInt16LE(22) : buffer.readUInt16LE(26)
  const bitsPerPixel = dibHeaderSize === 12 ? buffer.readUInt16LE(24) : buffer.readUInt16LE(28)
  return (dibHeaderSize === 12 || (dibHeaderSize >= 40 && dibHeaderSize <= 124)) &&
    colorPlanes === 1 &&
    [1, 4, 8, 16, 24, 32].includes(bitsPerPixel)
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte)
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  return buffer.length >= offset + text.length &&
    [...text].every((character, index) => buffer[offset + index] === character.charCodeAt(0))
}

function base64Size(buffer: Buffer): number {
  return Math.ceil(buffer.length / 3) * 4
}
