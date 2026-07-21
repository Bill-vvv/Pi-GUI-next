import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { normalizeExternalUrl } from '../../../../shared/external-url'
import {
  buildStreamingMarkdownModel,
  type StreamingMarkdownBlock
} from './streaming-markdown'

type MarkdownMessageProps = {
  text: string
  streaming: boolean
}

const remarkPlugins = [remarkGfm]

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
  const frameText = useFrameCoalescedText(text, streaming)
  return streaming
    ? <StreamingMarkdownDocument text={frameText} />
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
  return block.format === 'plain-text'
    ? <span className="markdown-streaming-plain-text">{block.text}</span>
    : <MarkdownFragment text={block.text} />
}, (previous, next) => (
  previous.block.text === next.block.text && previous.block.format === next.block.format
))

const MarkdownFragment = memo(function MarkdownFragment({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      components={markdownComponents}
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
      title={title}
      onClick={(event) => openExternalLink(event, href)}
    >
      {children}
    </a>
  )
}

function openExternalLink(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  event.preventDefault()
  void window.piGui.openExternal(href).catch((error: unknown) => {
    console.error('Failed to open external Markdown link.', error)
  })
}

function normalizeMarkdownUrl(url: string): string {
  return normalizeExternalUrl(url) ?? ''
}

function useFrameCoalescedText(text: string, streaming: boolean): string {
  const [frameText, setFrameText] = useState(text)
  const latestTextRef = useRef(text)
  const frameRef = useRef<number | null>(null)
  latestTextRef.current = text

  useLayoutEffect(() => {
    if (!streaming) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      setFrameText(text)
      return
    }

    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      setFrameText(latestTextRef.current)
    })
  }, [streaming, text])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  return streaming ? frameText : text
}
