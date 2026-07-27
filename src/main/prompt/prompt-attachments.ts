import type {
  KernelMessageAttachment,
  KernelPromptAttachment,
  KernelPromptImage
} from '../../shared/kernel-contract.ts'
import { formatPathReference } from '../../shared/path-reference.ts'

export type MaterializedPrompt = {
  message: string
  images: KernelPromptImage[]
}

export type PromptDisplay = {
  text: string
  attachments: KernelMessageAttachment[]
}

export function materializePrompt(
  message: string,
  attachments: readonly KernelPromptAttachment[] = []
): MaterializedPrompt {
  let attachmentText = ''
  const images: KernelPromptImage[] = []
  for (const attachment of attachments) {
    if (attachment.type === 'file') {
      attachmentText += `${formatPathReference(attachment.path)}\n`
      continue
    }
    const hints = attachment.hints.join('\n')
    attachmentText += `<file name="${attachment.path}">${hints}</file>\n`
    images.push(attachment.image)
  }
  return { message: `${attachmentText}${message}`, images }
}

export function projectPromptDisplay(content: unknown): PromptDisplay {
  const images: KernelPromptImage[] = []
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .map((item) => {
          if (isPromptImage(item)) {
            images.push(item)
            return null
          }
          return isRecord(item) && item.type === 'text' && typeof item.text === 'string'
            ? item.text
            : null
        })
        .filter((item): item is string => item !== null)
        .join('\n')
      : ''
  const parsed = parseLeadingAttachments(text)
  const blocks = parsed.attachments.filter(
    (attachment): attachment is ParsedFileBlock => attachment.type === 'block'
  )
  const imageBlocks = new Set(selectImageBlocks(blocks, images.length))
  let imageIndex = 0
  const attachments = parsed.attachments.map<KernelMessageAttachment>((attachment) => {
    if (attachment.type === 'reference') {
      return { type: 'file', name: fileName(attachment.path), path: attachment.path }
    }
    if (imageBlocks.has(attachment)) {
      imageIndex += 1
      return {
        type: 'image',
        name: fileName(attachment.path),
        path: attachment.path,
        hints: attachment.body.length === 0 ? [] : attachment.body.split('\n')
      }
    }
    return { type: 'file', name: fileName(attachment.path), path: attachment.path }
  })
  if (imageIndex < images.length) {
    for (; imageIndex < images.length; imageIndex += 1) {
      attachments.push({
        type: 'image',
        name: `image-${imageIndex + 1}`,
        path: '',
        hints: []
      })
    }
  }
  return { text: parsed.text, attachments }
}

export function stripPromptFileBlocks(message: string): string {
  const parsed = parseLeadingAttachments(message)
  if (parsed.attachments.length === 0) return parsed.text
  const references = parsed.attachments
    .map((attachment) => formatPathReference(fileName(attachment.path)))
    .join(' ')
  return parsed.text.trim().length === 0
    ? references
    : `${parsed.text}\n${references}`
}

const MESSAGE_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])
const MAX_MESSAGE_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024

export function findUserMessageForImageLookup(
  messages: readonly unknown[],
  messageId: string
): unknown {
  const history = /^message:history:(\d+):user$/u.exec(messageId)
  if (history !== null) {
    const index = Number(history[1])
    if (!Number.isInteger(index) || index < 0 || index >= messages.length) {
      throw new Error(`User message not found for ${messageId}.`)
    }
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') {
      throw new Error(`User message not found for ${messageId}.`)
    }
    return message
  }

  const live = /^message:user:(\d+)$/u.exec(messageId)
  if (live !== null) {
    const timestamp = Number(live[1])
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Unsupported message id for image lookup: ${messageId}`)
    }
    const matches = messages.filter((message) =>
      isRecord(message) &&
      message.role === 'user' &&
      typeof message.timestamp === 'number' &&
      message.timestamp === timestamp
    )
    if (matches.length !== 1) {
      throw new Error(`User message not found for ${messageId}.`)
    }
    return matches[0]
  }

  throw new Error(`Unsupported message id for image lookup: ${messageId}`)
}

export function extractProjectedMessageImage(
  message: unknown,
  attachmentIndex: number
): {
  mimeType: string
  data: string
  name: string
  path: string
} {
  if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
    throw new Error('Message image attachment index is invalid.')
  }
  if (!isRecord(message) || message.role !== 'user') {
    throw new Error('Message image lookup requires a user message.')
  }

  const display = projectPromptDisplay(message.content)
  const attachment = display.attachments[attachmentIndex]
  if (attachment === undefined || attachment.type !== 'image') {
    throw new Error('Message does not contain an image attachment at the requested index.')
  }

  let imageOrdinal = 0
  for (let index = 0; index < attachmentIndex; index += 1) {
    if (display.attachments[index]?.type === 'image') imageOrdinal += 1
  }

  const images = collectPromptImages(message.content)
  const image = images[imageOrdinal]
  if (image === undefined) {
    throw new Error('Session message is missing the projected image payload.')
  }
  if (!MESSAGE_IMAGE_MIME_TYPES.has(image.mimeType)) {
    throw new Error(`Unsupported message image type: ${image.mimeType}`)
  }
  if (
    image.data.length === 0 ||
    image.data.length > MAX_MESSAGE_IMAGE_BASE64_CHARS ||
    !isStrictBase64(image.data)
  ) {
    throw new Error('Session message image payload is invalid.')
  }

  return {
    mimeType: image.mimeType,
    data: image.data,
    name: attachment.name,
    path: attachment.path
  }
}

function collectPromptImages(content: unknown): KernelPromptImage[] {
  if (!Array.isArray(content)) return []
  const images: KernelPromptImage[] = []
  for (const item of content) {
    if (isPromptImage(item)) images.push(item)
  }
  return images
}

function isStrictBase64(value: string): boolean {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

type ParsedFileBlock = {
  type: 'block'
  path: string
  body: string
}

type ParsedFileReference = {
  type: 'reference'
  path: string
}

type ParsedAttachment = ParsedFileBlock | ParsedFileReference

function parseLeadingAttachments(value: string): { text: string; attachments: ParsedAttachment[] } {
  const attachments: ParsedAttachment[] = []
  let offset = 0
  while (offset < value.length) {
    const block = parseFileBlock(value, offset)
    if (block !== null) {
      attachments.push(block.attachment)
      offset = block.offset
      continue
    }
    const reference = parseFileReference(value, offset)
    if (reference !== null) {
      attachments.push(reference.attachment)
      offset = reference.offset
      continue
    }
    break
  }
  return { text: value.slice(offset), attachments }
}

function parseFileBlock(
  value: string,
  offset: number
): { attachment: ParsedFileBlock; offset: number } | null {
  if (!value.startsWith('<file name="', offset)) return null
  const nameStart = offset + '<file name="'.length
  const nameEnd = value.indexOf('">', nameStart)
  if (nameEnd === -1) return null
  const path = value.slice(nameStart, nameEnd)
  if (path.length === 0 || /[\r\n"]/u.test(path)) return null
  const bodyStart = nameEnd + 2
  const close = value.indexOf('</file>\n', bodyStart)
  if (close === -1) return null
  const rawBody = value.slice(bodyStart, close)
  const body = rawBody.startsWith('\n') && rawBody.endsWith('\n')
    ? rawBody.slice(1, -1)
    : rawBody
  return {
    attachment: { type: 'block', path, body },
    offset: close + '</file>\n'.length
  }
}

function parseFileReference(
  value: string,
  offset: number
): { attachment: ParsedFileReference; offset: number } | null {
  if (value[offset] !== '@') return null
  const lineEnd = value.indexOf('\n', offset)
  if (lineEnd === -1) return null
  const token = value.slice(offset + 1, lineEnd)
  let path: string
  if (token.startsWith('"')) {
    if (!token.endsWith('"')) return null
    path = unescapeQuotedPath(token.slice(1, -1))
  } else {
    if (token.length === 0 || /\s/u.test(token)) return null
    path = token
  }
  if (path.length === 0 || /[\r\n]/u.test(path)) return null
  return {
    attachment: { type: 'reference', path },
    offset: lineEnd + 1
  }
}

function selectImageBlocks(blocks: ParsedFileBlock[], imageCount: number): ParsedFileBlock[] {
  const result: ParsedFileBlock[] = []
  if (imageCount === 0) return result
  for (const block of blocks) {
    if (
      result.length < imageCount &&
      (
        block.body.length === 0 ||
        block.body.split('\n').every((line) => /^\[Image(?::| ).*\]$/u.test(line))
      )
    ) {
      result.push(block)
    }
  }
  return result
}

function unescapeQuotedPath(path: string): string {
  let result = ''
  for (let index = 0; index < path.length; index += 1) {
    const character = path[index]
    if (character === '\\' && index + 1 < path.length) {
      index += 1
      result += path[index]
    } else {
      result += character
    }
  }
  return result
}

function isPromptImage(value: unknown): value is KernelPromptImage {
  return isRecord(value) &&
    value.type === 'image' &&
    typeof value.mimeType === 'string' &&
    typeof value.data === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path
}
