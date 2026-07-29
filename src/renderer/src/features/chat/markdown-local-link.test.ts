import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true }
})
after(async () => vite.close())

const markdownModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/MarkdownMessage.tsx'
) as typeof import('./MarkdownMessage.tsx')
const { MarkdownMessage } = markdownModule

test('Markdown renders absolute Linux report paths as clickable file URLs', () => {
  const html = renderToStaticMarkup(createElement(MarkdownMessage, {
    text: '[REPORT.md](/home/vvv/Projects/report.md)',
    streaming: false
  }))

  assert.match(html, /<a href="file:\/\/\/home\/vvv\/Projects\/report\.md"/)
  assert.match(html, />REPORT\.md<\/a>/)
})
