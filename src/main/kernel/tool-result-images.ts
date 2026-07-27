import type {
  KernelMessageImage,
  KernelToolImageAttachment
} from '../../shared/kernel-contract.ts'
import { isRecord } from '../utils/guards.ts'

export type ToolImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export const TOOL_IMAGE_MIME_TYPES = new Set<ToolImageMimeType>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])

/** Shared with prompt/message image lookup: max base64 character length. */
export const MAX_TOOL_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024

export type ProjectedToolResultContent = {
  text: string
  attachments: KernelToolImageAttachment[]
}

export type ValidatedToolImage = {
  contentIndex: number
  mimeType: ToolImageMimeType
  data: string
  byteLength: number
  name: string
}

export class ToolResultMessageNotFoundError extends Error {
  constructor(toolCallId: string) {
    super(`Tool result not found for toolCallId: ${toolCallId}`)
    this.name = 'ToolResultMessageNotFoundError'
  }
}

/**
 * Project tool-result content into display text + metadata-only image attachments.
 * Invalid image blocks are ignored without discarding sibling text or valid images.
 */
export function projectToolResultContent(content: unknown): ProjectedToolResultContent {
  if (typeof content === 'string') {
    return { text: content, attachments: [] }
  }
  if (!Array.isArray(content)) {
    return { text: '', attachments: [] }
  }

  const textParts: string[] = []
  const attachments: KernelToolImageAttachment[] = []
  let imageOrdinal = 0

  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const item = content[contentIndex]
    if (!isRecord(item)) continue
    if (item.type === 'text') {
      const text = typeof item.text === 'string' ? item.text : null
      if (text !== null) textParts.push(text)
      continue
    }
    if (item.type !== 'image') continue
    const validated = validateToolImageBlock(item, contentIndex)
    if (validated === null) continue
    imageOrdinal += 1
    attachments.push({
      type: 'image',
      name: validated.name.length > 0 ? validated.name : `image-${imageOrdinal}`,
      mimeType: validated.mimeType,
      byteLength: validated.byteLength,
      contentIndex: validated.contentIndex
    })
  }

  return {
    text: textParts.join('\n'),
    attachments
  }
}

/**
 * Growth-only merge for live tool updates: empty/invalid partials must not erase
 * previously projected terminal image metadata for the same toolCallId.
 */
export function mergeToolImageAttachments(
  existing: readonly KernelToolImageAttachment[] | undefined,
  next: readonly KernelToolImageAttachment[]
): KernelToolImageAttachment[] | undefined {
  if (next.length > 0) return next.map((attachment) => ({ ...attachment }))
  if (existing === undefined || existing.length === 0) return undefined
  return existing.map((attachment) => ({ ...attachment }))
}

export function sameToolImageAttachments(
  first: readonly KernelToolImageAttachment[] | undefined,
  second: readonly KernelToolImageAttachment[] | undefined
): boolean {
  if (first === second) return true
  if (first === undefined || second === undefined || first.length !== second.length) return false
  return first.every((attachment, index) => {
    const other = second[index]
    return other !== undefined &&
      attachment.type === other.type &&
      attachment.name === other.name &&
      attachment.mimeType === other.mimeType &&
      attachment.byteLength === other.byteLength &&
      attachment.contentIndex === other.contentIndex
  })
}

export function copyToolImageAttachments(
  attachments: readonly KernelToolImageAttachment[] | undefined
): KernelToolImageAttachment[] | undefined {
  if (attachments === undefined) return undefined
  return attachments.map((attachment) => ({ ...attachment }))
}

export function findToolResultMessage(
  messages: readonly unknown[],
  toolCallId: string
): unknown {
  const matches = messages.filter((message) =>
    isRecord(message) &&
    message.role === 'toolResult' &&
    typeof message.toolCallId === 'string' &&
    message.toolCallId === toolCallId
  )
  if (matches.length === 0) {
    throw new ToolResultMessageNotFoundError(toolCallId)
  }
  if (matches.length > 1) {
    throw new Error(`Multiple tool results found for toolCallId: ${toolCallId}`)
  }
  return matches[0]
}

export function extractToolResultImage(
  message: unknown,
  contentIndex: number
): KernelMessageImage {
  if (!Number.isInteger(contentIndex) || contentIndex < 0) {
    throw new Error('Tool image content index is invalid.')
  }
  if (!isRecord(message) || message.role !== 'toolResult') {
    throw new Error('Tool image lookup requires a toolResult message.')
  }
  if (!Array.isArray(message.content)) {
    throw new Error('Tool result does not contain image content blocks.')
  }
  if (contentIndex >= message.content.length) {
    throw new Error('Tool image content index is out of range.')
  }
  const block = message.content[contentIndex]
  const validated = validateToolImageBlock(block, contentIndex)
  if (validated === null) {
    throw new Error('Tool result image payload is invalid.')
  }
  return {
    mimeType: validated.mimeType,
    data: validated.data,
    name: validated.name.length > 0 ? validated.name : `image-${contentIndex + 1}`,
    path: ''
  }
}

export function validateToolImageBlock(
  value: unknown,
  contentIndex: number
): ValidatedToolImage | null {
  if (!isRecord(value) || value.type !== 'image') return null
  if (typeof value.mimeType !== 'string' || !isToolImageMimeType(value.mimeType)) return null
  if (typeof value.data !== 'string') return null
  if (
    value.data.length === 0 ||
    value.data.length > MAX_TOOL_IMAGE_BASE64_CHARS ||
    !isStrictBase64(value.data)
  ) return null

  let bytes: Buffer
  try {
    bytes = Buffer.from(value.data, 'base64')
  } catch {
    return null
  }
  if (bytes.length === 0) return null

  const detected = detectImageMimeType(bytes)
  if (detected === null || detected !== value.mimeType) return null

  const name = typeof value.name === 'string' && value.name.trim().length > 0
    ? value.name.trim().slice(0, 256)
    : typeof value.fileName === 'string' && value.fileName.trim().length > 0
      ? value.fileName.trim().slice(0, 256)
      : ''

  return {
    contentIndex,
    mimeType: detected,
    data: value.data,
    byteLength: bytes.length,
    name
  }
}

export function collectValidatedToolImages(content: unknown): ValidatedToolImage[] {
  if (!Array.isArray(content)) return []
  const images: ValidatedToolImage[] = []
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const validated = validateToolImageBlock(content[contentIndex], contentIndex)
    if (validated !== null) images.push(validated)
  }
  return images
}

function isToolImageMimeType(value: string): value is ToolImageMimeType {
  return value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/gif' ||
    value === 'image/webp'
}

function isStrictBase64(value: string): boolean {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function detectImageMimeType(bytes: Buffer): ToolImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWithAscii(bytes, 0, 'GIF87a') || startsWithAscii(bytes, 0, 'GIF89a')) return 'image/gif'
  if (startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) return 'image/webp'
  return null
}

function startsWith(bytes: Buffer, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte)
}

function startsWithAscii(bytes: Buffer, offset: number, text: string): boolean {
  return bytes.length >= offset + text.length &&
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}
