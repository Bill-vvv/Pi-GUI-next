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
