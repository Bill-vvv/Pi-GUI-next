import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { normalizeExternalUrl } from '../../shared/external-url.ts'
import { projectMessages } from '../kernel/conversation-projection.ts'

export type SessionExportSource = {
  title: string | null
  messages: unknown[]
}

type MarkdownNode = {
  type?: unknown
  value?: unknown
  children?: unknown
  depth?: unknown
  ordered?: unknown
  start?: unknown
  checked?: unknown
  lang?: unknown
  url?: unknown
  title?: unknown
  alt?: unknown
  identifier?: unknown
  align?: unknown
}

type MarkdownContext = {
  definitions: Map<string, { url: string; title: string | null }>
}

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
])
const MAX_PI_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'"
].join('; ')

const MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm)

export function createSessionExportHtml(source: SessionExportSource): string {
  const title = source.title ?? 'Untitled session'
  const messages = renderMessages(source.messages)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(CONTENT_SECURITY_POLICY)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.55; }
body { box-sizing: border-box; max-width: 54rem; margin: 0 auto; padding: 2rem 1rem 4rem; overflow-wrap: anywhere; }
h1 { margin: 0 0 2rem; font-size: 1.8rem; }
.message { margin: 1.5rem 0; padding: 1rem 1.25rem; border: 1px solid currentColor; border-radius: .75rem; }
.message > h2 { margin-top: 0; font: inherit; font-weight: 700; opacity: .7; }
pre { overflow-x: auto; padding: 1rem; border-radius: .5rem; background: color-mix(in srgb, currentColor 10%, transparent); }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
blockquote { margin-left: 0; padding-left: 1rem; border-left: .25rem solid currentColor; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: .4rem .6rem; border: 1px solid currentColor; text-align: left; }
img { display: block; max-width: 100%; height: auto; margin: .75rem 0; }
.markdown-image { opacity: .75; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${messages}
</body>
</html>
`
}

function renderMessages(messages: unknown[]): string {
  const rendered: string[] = []

  for (const message of messages) {
    if (!isRecord(message) || typeof message.role !== 'string') continue

    if (message.role === 'user') {
      rendered.push(renderMessage('User', renderUserContent(message.content)))
      continue
    }

    if (message.role !== 'assistant') continue
    for (const entry of projectMessages([message])) {
      if (
        entry.kind !== 'message' ||
        entry.role !== 'assistant' ||
        entry.phase === 'commentary'
      ) continue
      rendered.push(renderMessage('Assistant', renderMarkdown(entry.text)))
    }
  }

  return rendered.join('\n')
}

function renderMessage(role: string, content: string): string {
  return `<section class="message"><h2>${role}</h2>${content}</section>`
}

function renderUserContent(content: unknown): string {
  if (typeof content === 'string') return renderMarkdown(content)
  if (!Array.isArray(content)) return ''

  const blocks: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push(renderMarkdown(block.text))
      continue
    }
    const image = renderPiImage(block)
    if (image !== null) blocks.push(image)
  }
  return blocks.join('')
}

function renderPiImage(block: Record<string, unknown>): string | null {
  if (
    block.type !== 'image' ||
    typeof block.mimeType !== 'string' ||
    !IMAGE_MIME_TYPES.has(block.mimeType) ||
    typeof block.data !== 'string' ||
    block.data.length > MAX_PI_IMAGE_BASE64_CHARS ||
    !isStrictBase64(block.data)
  ) return null

  const source = `data:${block.mimeType};base64,${block.data}`
  return `<img src="${escapeAttribute(source)}" alt="User image">`
}

function isStrictBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return false

  return Buffer.from(value, 'base64').toString('base64') === value
}

function renderMarkdown(markdown: string): string {
  const root = MARKDOWN_PARSER.parse(markdown) as MarkdownNode
  const context: MarkdownContext = { definitions: new Map() }
  collectDefinitions(root, context.definitions)
  return serializeNode(root, context)
}

function collectDefinitions(
  node: MarkdownNode,
  definitions: Map<string, { url: string; title: string | null }>
): void {
  if (
    node.type === 'definition' &&
    typeof node.identifier === 'string' &&
    typeof node.url === 'string'
  ) {
    definitions.set(normalizeIdentifier(node.identifier), {
      url: node.url,
      title: typeof node.title === 'string' ? node.title : null
    })
  }
  for (const child of childrenOf(node)) collectDefinitions(child, definitions)
}

function serializeNode(node: MarkdownNode, context: MarkdownContext): string {
  switch (node.type) {
    case 'root':
      return serializeChildren(node, context)
    case 'text':
      return escapeHtml(stringValue(node.value))
    case 'paragraph':
      return `<p>${serializeChildren(node, context)}</p>`
    case 'heading': {
      const depth = numberInRange(node.depth, 1, 6) ?? 2
      return `<h${depth}>${serializeChildren(node, context)}</h${depth}>`
    }
    case 'blockquote':
      return `<blockquote>${serializeChildren(node, context)}</blockquote>`
    case 'list': {
      const tag = node.ordered === true ? 'ol' : 'ul'
      const start = tag === 'ol' && typeof node.start === 'number' && Number.isInteger(node.start)
        ? ` start="${node.start}"`
        : ''
      return `<${tag}${start}>${serializeChildren(node, context)}</${tag}>`
    }
    case 'listItem': {
      const task = typeof node.checked === 'boolean'
        ? `<span aria-hidden="true">${node.checked ? '☑' : '☐'}</span> `
        : ''
      return `<li>${task}${serializeChildren(node, context)}</li>`
    }
    case 'emphasis':
      return `<em>${serializeChildren(node, context)}</em>`
    case 'strong':
      return `<strong>${serializeChildren(node, context)}</strong>`
    case 'delete':
      return `<del>${serializeChildren(node, context)}</del>`
    case 'inlineCode':
      return `<code>${escapeHtml(stringValue(node.value))}</code>`
    case 'code': {
      const language = safeLanguage(node.lang)
      const className = language === null ? '' : ` class="language-${language}"`
      return `<pre><code${className}>${escapeHtml(stringValue(node.value))}</code></pre>`
    }
    case 'break':
      return '<br>'
    case 'thematicBreak':
      return '<hr>'
    case 'link':
      return serializeLink(
        typeof node.url === 'string' ? node.url : '',
        typeof node.title === 'string' ? node.title : null,
        serializeChildren(node, context)
      )
    case 'linkReference': {
      const definition = typeof node.identifier === 'string'
        ? context.definitions.get(normalizeIdentifier(node.identifier))
        : undefined
      return definition === undefined
        ? serializeChildren(node, context)
        : serializeLink(definition.url, definition.title, serializeChildren(node, context))
    }
    case 'image':
      return serializeMarkdownImage(
        typeof node.url === 'string' ? node.url : '',
        typeof node.alt === 'string' ? node.alt : ''
      )
    case 'imageReference': {
      const definition = typeof node.identifier === 'string'
        ? context.definitions.get(normalizeIdentifier(node.identifier))
        : undefined
      return serializeMarkdownImage(
        definition?.url ?? '',
        typeof node.alt === 'string' ? node.alt : ''
      )
    }
    case 'table':
      return serializeTable(node, context)
    case 'tableRow':
      return `<tr>${serializeChildren(node, context)}</tr>`
    case 'tableCell':
      return `<td>${serializeChildren(node, context)}</td>`
    case 'html':
      return escapeHtml(stringValue(node.value))
    case 'definition':
      return ''
    default:
      return serializeChildren(node, context)
  }
}

function serializeTable(node: MarkdownNode, context: MarkdownContext): string {
  const rows = childrenOf(node)
  if (rows.length === 0) return '<table></table>'

  const alignments = Array.isArray(node.align) ? node.align : []
  const headerCells = childrenOf(rows[0]).map((cell, index) => (
    `<th${alignmentAttribute(alignments[index])}>${serializeChildren(cell, context)}</th>`
  )).join('')
  const bodyRows = rows.slice(1).map((row) => {
    const cells = childrenOf(row).map((cell, index) => (
      `<td${alignmentAttribute(alignments[index])}>${serializeChildren(cell, context)}</td>`
    )).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  return `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
}

function alignmentAttribute(value: unknown): string {
  return value === 'left' || value === 'center' || value === 'right'
    ? ` style="text-align:${value}"`
    : ''
}

function serializeLink(url: string, title: string | null, children: string): string {
  const normalized = normalizeExternalUrl(url)
  if (normalized === null) return children
  const titleAttribute = title === null ? '' : ` title="${escapeAttribute(title)}"`
  return `<a href="${escapeAttribute(normalized)}"${titleAttribute} rel="noreferrer noopener" target="_blank">${children}</a>`
}

function serializeMarkdownImage(url: string, alt: string): string {
  const normalized = normalizeExternalUrl(url)
  const label = alt.length > 0 ? alt : 'Image'
  if (
    normalized !== null &&
    (normalized.startsWith('http://') || normalized.startsWith('https://'))
  ) {
    return `<span class="markdown-image">Image: <a href="${escapeAttribute(normalized)}" rel="noreferrer noopener" target="_blank">${escapeHtml(label)}</a></span>`
  }
  return `<span class="markdown-image">[Image: ${escapeHtml(label)}]</span>`
}

function serializeChildren(node: MarkdownNode, context: MarkdownContext): string {
  return childrenOf(node).map((child) => serializeNode(child, context)).join('')
}

function childrenOf(node: MarkdownNode): MarkdownNode[] {
  return Array.isArray(node.children)
    ? node.children.filter((child): child is MarkdownNode => isRecord(child))
    : []
}

function safeLanguage(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_+-]+$/.test(value) ? value : null
}

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function numberInRange(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
