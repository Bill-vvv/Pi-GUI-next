import type {
  KernelMessageAttachment,
  KernelPromptAttachment,
  KernelPromptImage
} from '../../shared/kernel-contract.ts'

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
  let fileText = ''
  const images: KernelPromptImage[] = []
  for (const attachment of attachments) {
    if (attachment.type === 'file') {
      fileText += `<file name="${attachment.path}">\n${attachment.content}\n</file>\n`
      continue
    }
    const hints = attachment.hints.join('\n')
    fileText += `<file name="${attachment.path}">${hints}</file>\n`
    images.push(attachment.image)
  }
  return { message: `${fileText}${message}`, images }
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
  const parsed = parseLeadingFileBlocks(text)
  const imageBlockIndexes = selectImageBlockIndexes(parsed.blocks, images.length)
  let imageIndex = 0
  const attachments = parsed.blocks.map<KernelMessageAttachment>((block, index) => {
    if (imageBlockIndexes.has(index)) {
      imageIndex += 1
      return {
        type: 'image',
        name: fileName(block.path),
        path: block.path,
        hints: block.body.length === 0 ? [] : block.body.split('\n')
      }
    }
    return { type: 'file', name: fileName(block.path), path: block.path }
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
  return parseLeadingFileBlocks(message).text
}

type ParsedFileBlock = {
  path: string
  body: string
}

function parseLeadingFileBlocks(value: string): { text: string; blocks: ParsedFileBlock[] } {
  const blocks: ParsedFileBlock[] = []
  let offset = 0
  while (value.startsWith('<file name="', offset)) {
    const nameStart = offset + '<file name="'.length
    const nameEnd = value.indexOf('">', nameStart)
    if (nameEnd === -1) break
    const path = value.slice(nameStart, nameEnd)
    if (path.length === 0 || /[\r\n"]/u.test(path)) break
    const bodyStart = nameEnd + 2
    const close = value.indexOf('</file>\n', bodyStart)
    if (close === -1) break
    const rawBody = value.slice(bodyStart, close)
    const body = rawBody.startsWith('\n') && rawBody.endsWith('\n')
      ? rawBody.slice(1, -1)
      : rawBody
    blocks.push({ path, body })
    offset = close + '</file>\n'.length
  }
  return { text: value.slice(offset), blocks }
}

function selectImageBlockIndexes(blocks: ParsedFileBlock[], imageCount: number): Set<number> {
  const result = new Set<number>()
  if (imageCount === 0) return result
  for (const [index, block] of blocks.entries()) {
    if (
      result.size < imageCount &&
      (
        block.body.length === 0 ||
        block.body.split('\n').every((line) => /^\[Image(?::| ).*\]$/u.test(line))
      )
    ) {
      result.add(index)
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
