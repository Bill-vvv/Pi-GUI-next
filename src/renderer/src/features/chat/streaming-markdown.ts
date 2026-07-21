import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type StreamingMarkdownBlock = {
  id: string
  text: string
  stable: boolean
  start: number
  end: number
}

export type StreamingMarkdownModel = {
  blocks: StreamingMarkdownBlock[]
  sourceText: string
  wholeDocument: boolean
}

type PositionedNode = {
  type: string
  position?: {
    start: { offset?: number }
    end: { offset?: number }
  }
  children?: PositionedNode[]
}

const streamingParser = unified().use(remarkParse).use(remarkGfm)
const STREAMING_TAIL_PARSE_BUDGET = 16_384

export function buildStreamingMarkdownModel(
  text: string,
  previous?: StreamingMarkdownModel
): StreamingMarkdownModel {
  const reusable = reusablePrefix(text, previous)
  const prefix = reusable?.blocks ?? []
  const cursor = reusable?.cursor ?? 0
  const parsed = parseTail(text, cursor)

  if (parsed.exceededParseBudget) {
    return {
      blocks: text.length === 0 ? [] : [block('markdown-whole', text, 0, text.length, false)],
      sourceText: text,
      wholeDocument: true
    }
  }

  if (parsed.hasDocumentWideDefinition) {
    return {
      blocks: text.length === 0 ? [] : [block('markdown-whole', text, 0, text.length, false)],
      sourceText: text,
      wholeDocument: true
    }
  }

  return {
    blocks: [...prefix, ...parsed.blocks],
    sourceText: text,
    wholeDocument: false
  }
}

function reusablePrefix(
  text: string,
  previous: StreamingMarkdownModel | undefined
): { blocks: StreamingMarkdownBlock[]; cursor: number } | null {
  if (
    !previous ||
    previous.wholeDocument ||
    text.length < previous.sourceText.length ||
    !text.startsWith(previous.sourceText)
  ) {
    return null
  }

  const blocks = previous.blocks.filter((candidate) => candidate.stable)
  return { blocks, cursor: blocks.at(-1)?.end ?? 0 }
}

function parseTail(
  sourceText: string,
  cursor: number
): {
  blocks: StreamingMarkdownBlock[]
  hasDocumentWideDefinition: boolean
  exceededParseBudget: boolean
} {
  const tail = sourceText.slice(cursor)
  if (tail.length === 0) {
    return { blocks: [], hasDocumentWideDefinition: false, exceededParseBudget: false }
  }

  if (tail.length > STREAMING_TAIL_PARSE_BUDGET) {
    return {
      blocks: [],
      hasDocumentWideDefinition: false,
      exceededParseBudget: true
    }
  }

  const root = streamingParser.parse(tail) as PositionedNode
  if (hasDocumentWideDefinition(root)) {
    return { blocks: [], hasDocumentWideDefinition: true, exceededParseBudget: false }
  }

  const children = root.children
  if (!Array.isArray(children) || children.length === 0) {
    return {
      blocks: [block(`markdown-tail-${cursor}`, tail, cursor, sourceText.length, false)],
      hasDocumentWideDefinition: false,
      exceededParseBudget: false
    }
  }

  const blocks = children.map((node, index) => {
    const relativeStart = index === 0 ? 0 : node.position?.start.offset
    const nextStart = children[index + 1]?.position?.start.offset
    if (relativeStart === undefined || (index < children.length - 1 && nextStart === undefined)) {
      throw new Error('Markdown parser did not provide source offsets.')
    }

    const start = cursor + relativeStart
    const end = nextStart === undefined ? sourceText.length : cursor + nextStart
    const stable = index < children.length - 1
    return block(stable ? `markdown-${start}` : `markdown-tail-${start}`, sourceText.slice(start, end), start, end, stable)
  })

  return { blocks, hasDocumentWideDefinition: false, exceededParseBudget: false }
}

function hasDocumentWideDefinition(node: PositionedNode): boolean {
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return true
  return node.children?.some(hasDocumentWideDefinition) ?? false
}

function block(
  id: string,
  text: string,
  start: number,
  end: number,
  stable: boolean
): StreamingMarkdownBlock {
  return { id, text, stable, start, end }
}
