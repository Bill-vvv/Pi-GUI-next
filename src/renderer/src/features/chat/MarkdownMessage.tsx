import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type ReactNode
} from 'react'
import 'katex/dist/katex.min.css'

import rehypeKatex, { type Options as KatexOptions } from 'rehype-katex'
import ReactMarkdown, { type Components, type Options as MarkdownOptions } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math-extended'

import { getRendererHost } from '../../host'
import {
  buildStreamingMarkdownModel,
  type StreamingMarkdownBlock
} from './streaming-markdown'

type MarkdownMessageProps = {
  text: string
  streaming: boolean
}

const remarkPlugins: NonNullable<MarkdownOptions['remarkPlugins']> = [remarkGfm, remarkMath]
const katexOptions: KatexOptions = {
  errorColor: 'var(--color-error-text)',
  strict: 'warn',
  trust: false
}
const rehypePlugins: NonNullable<MarkdownOptions['rehypePlugins']> = [
  [rehypeKatex, katexOptions]
]

const markdownComponents: Components = {
  a({ href, children, title }) {
    return <ExternalLink href={href} title={title}>{children}</ExternalLink>
  },
  img({ src, alt, title }) {
    return (
      <span className="markdown-image-link">
        图片：<ExternalLink href={typeof src === 'string' ? src : undefined} title={title}>
          {alt || src || '未命名图片'}
        </ExternalLink>
      </span>
    )
  }
}

export const MarkdownMessage = memo(function MarkdownMessage({
  text,
  streaming
}: MarkdownMessageProps): React.JSX.Element {
  return streaming
    ? <StreamingMarkdownDocument text={text} />
    : <div className="markdown-message"><MarkdownFragment text={text} /></div>
})

const StreamingMarkdownDocument = memo(function StreamingMarkdownDocument({
  text
}: {
  text: string
}): React.JSX.Element {
  const previousModelRef = useRef<ReturnType<typeof buildStreamingMarkdownModel> | undefined>(undefined)
  const model = useMemo(
    () => buildStreamingMarkdownModel(text, previousModelRef.current),
    [text]
  )
  useLayoutEffect(() => {
    previousModelRef.current = model
  }, [model])

  return (
    <div className="markdown-message">
      {model.blocks.map((block) => <MarkdownBlock block={block} key={block.id} />)}
    </div>
  )
})

const MarkdownBlock = memo(function MarkdownBlock({
  block
}: {
  block: StreamingMarkdownBlock
}): React.JSX.Element {
  return <MarkdownFragment text={block.text} />
}, (previous, next) => (
  previous.block.text === next.block.text
))

const MarkdownFragment = memo(function MarkdownFragment({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      components={markdownComponents}
      rehypePlugins={rehypePlugins}
      remarkPlugins={remarkPlugins}
      skipHtml
      urlTransform={normalizeMarkdownUrl}
    >
      {text}
    </ReactMarkdown>
  )
})

function ExternalLink({
  href,
  title,
  children
}: {
  href: string | undefined
  title?: string
  children: ReactNode
}): React.JSX.Element {
  if (!href) return <span>{children}</span>

  return (
    <a
      href={href}
      rel="noreferrer"
      target="_blank"
      data-tooltip={title}
      onClick={(event) => openExternalLink(event, href)}
    >
      {children}
    </a>
  )
}

function openExternalLink(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  event.preventDefault()
  void getRendererHost().openExternal(href).catch((error: unknown) => {
    console.error('Failed to open external Markdown link.', error)
  })
}

function normalizeMarkdownUrl(url: string): string {
  return getRendererHost().normalizeOpenTarget(url) ?? ''
}
