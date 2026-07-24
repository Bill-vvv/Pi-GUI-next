import type {
  KernelPromptAttachment,
  KernelPromptImage
} from '../../../../shared/kernel-contract'

const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024
const IMAGE_SIGNATURE_BYTES = 12

type SupportedImageMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/bmp'

export async function readDroppedPromptAttachments(
  files: readonly File[],
  getPathForFile: (file: File) => string
): Promise<KernelPromptAttachment[]> {
  const uniqueFiles = deduplicateFiles(files).filter((file) => file.size > 0)
  return Promise.all(uniqueFiles.map((file) => readPromptAttachment(file, getPathForFile)))
}

async function readPromptAttachment(
  file: File,
  getPathForFile: (file: File) => string
): Promise<KernelPromptAttachment> {
  const header = new Uint8Array(await file.slice(0, IMAGE_SIGNATURE_BYTES).arrayBuffer())
  const mimeType = detectImage(header, file)
  if (mimeType === null) {
    if (looksLikeImage(file)) throw new Error(`无法处理图片：${file.name}`)
    return {
      type: 'file',
      name: file.name,
      path: requiredFilePath(file, getPathForFile)
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const processed = await processImage(file, bytes, mimeType)
  return {
    type: 'image',
    name: file.name,
    path: filePathOrName(file, getPathForFile),
    image: processed.image,
    hints: processed.hints
  }
}

async function processImage(
  file: File,
  bytes: Uint8Array,
  mimeType: SupportedImageMimeType
): Promise<{ image: KernelPromptImage; hints: string[] }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(`无法解码图片：${file.name}`)
  }

  try {
    const original = { width: bitmap.width, height: bitmap.height }
    if (original.width <= 0 || original.height <= 0) {
      throw new Error(`图片尺寸无效：${file.name}`)
    }
    if (
      mimeType !== 'image/bmp' &&
      original.width <= MAX_WIDTH &&
      original.height <= MAX_HEIGHT &&
      base64Size(bytes.byteLength) < MAX_BASE64_BYTES
    ) {
      return {
        image: { type: 'image', mimeType, data: bytesToBase64(bytes) },
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
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) throw new Error(`无法处理图片：${file.name}`)
      context.drawImage(bitmap, 0, 0, width, height)

      const candidate = await firstInlineCandidate(canvas)
      if (candidate !== null) {
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
            data: bytesToBase64(new Uint8Array(await candidate.blob.arrayBuffer()))
          },
          hints
        }
      }

      if (width === 1 && height === 1) break
      width = width === 1 ? 1 : Math.max(1, Math.floor(width * 0.75))
      height = height === 1 ? 1 : Math.max(1, Math.floor(height * 0.75))
    }
  } finally {
    bitmap.close()
  }
  throw new Error(`图片无法压缩到附件大小限制内：${file.name}`)
}

async function firstInlineCandidate(
  canvas: HTMLCanvasElement
): Promise<{ blob: Blob; mimeType: 'image/png' | 'image/jpeg' } | null> {
  const candidates: Array<{
    mimeType: 'image/png' | 'image/jpeg'
    quality?: number
  }> = [
    { mimeType: 'image/png' },
    { mimeType: 'image/jpeg', quality: 0.85 },
    { mimeType: 'image/jpeg', quality: 0.8 },
    { mimeType: 'image/jpeg', quality: 0.7 },
    { mimeType: 'image/jpeg', quality: 0.55 },
    { mimeType: 'image/jpeg', quality: 0.4 }
  ]
  for (const candidate of candidates) {
    const blob = await canvasToBlob(canvas, candidate.mimeType, candidate.quality)
    if (blob.size > 0 && base64Size(blob.size) < MAX_BASE64_BYTES) {
      return { blob, mimeType: candidate.mimeType }
    }
  }
  return null
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: 'image/png' | 'image/jpeg',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('浏览器无法编码图片。'))
      else resolve(blob)
    }, mimeType, quality)
  })
}

function deduplicateFiles(files: readonly File[]): File[] {
  const seen = new Set<string>()
  return files.filter((file) => {
    const key = `${file.name}\0${file.type}\0${file.size}\0${file.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function detectImage(bytes: Uint8Array, file: File): SupportedImageMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWithAscii(bytes, 0, 'GIF')) return 'image/gif'
  if (startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) return 'image/webp'
  if (startsWithAscii(bytes, 0, 'BM')) return 'image/bmp'
  return looksLikeImage(file) ? normalizeImageMimeType(file.type) : null
}

function normalizeImageMimeType(value: string): SupportedImageMimeType | null {
  if (value === 'image/jpg') return 'image/jpeg'
  if (
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/gif' ||
    value === 'image/webp' ||
    value === 'image/bmp'
  ) return value
  return null
}

function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(?:bmp|gif|jpe?g|png|webp)$/i.test(file.name)
}

function requiredFilePath(file: File, getPathForFile: (file: File) => string): string {
  const path = getPathForFile(file).trim()
  if (path.length === 0) throw new Error(`无法获取文件的本地路径：${file.name}`)
  return path
}

function filePathOrName(file: File, getPathForFile: (file: File) => string): string {
  try {
    return requiredFilePath(file, getPathForFile)
  } catch {
    return file.name
  }
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return bytes.length >= offset + text.length &&
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64Size(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}
