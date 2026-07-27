import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type {
  KernelConversationEntry,
  KernelThinkingEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false }
})
after(async () => vite.close())

const timelineModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/TimelineTurns.tsx'
) as typeof import('./TimelineTurns.tsx')
const { latestThinkingSummaryLabel, LiveTurn } = timelineModule

test('latest thinking summary status uses the newest semantic line without markdown wrappers', () => {
  const entries: KernelConversationEntry[] = [
    thinking('older', '**Inspecting the project**'),
    thinking('newer', '**Analyzing the state**\n\n**Planning the fix**')
  ]

  assert.equal(latestThinkingSummaryLabel(entries), 'Planning the fix')
  const html = renderLiveTurn(entries)
  assert.match(html, />Planning the fix</)
  assert.doesNotMatch(html, />正在继续</)
})

test('active thinking summary replaces generic status without repeating a single-line detail', () => {
  const summary = thinking('streaming', '**Tracing the display path**', true)
  const standardHtml = renderLiveTurn([summary])
  assert.match(standardHtml, />Tracing the display path</)
  assert.doesNotMatch(standardHtml, />正在思考</)

  const detailedHtml = renderLiveTurn([summary], 'detailed')
  assert.match(detailedHtml, />Tracing the display path</)
  assert.doesNotMatch(detailedHtml, />正在思考</)
  assert.doesNotMatch(detailedHtml, /process-thinking-detail/)
})

test('active tools keep priority over the latest thinking summary', () => {
  const summary = thinking('streaming', '**Tracing the display path**', true)
  const tool: KernelToolEntry = {
    id: 'tool:read',
    kind: 'tool',
    toolCallId: 'read',
    name: 'read',
    status: 'running',
    args: JSON.stringify({ path: '/tmp/example.ts' }),
    output: '',
    details: '',
    truncated: false,
    timestamp: 2,
    durationMs: null,
    subagent: null
  }
  const toolHtml = renderLiveTurn([summary, tool])
  assert.match(toolHtml, />正在阅读 example\.ts</)
  assert.doesNotMatch(toolHtml, />Tracing the display path</)
})

test('waiting status falls back when no usable summary exists', () => {
  const entries = [
    thinking('narrative', 'Full reasoning text', false, false),
    thinking('empty-summary', '   ')
  ]
  assert.equal(latestThinkingSummaryLabel(entries), null)
  assert.match(renderLiveTurn(entries), />正在继续</)
})

function renderLiveTurn(
  entries: KernelConversationEntry[],
  toolDisplayDensity: 'compact' | 'standard' | 'detailed' = 'standard'
): string {
  return renderToStaticMarkup(createElement(LiveTurn, {
    turn: { id: 'turn', entries },
    toolDisplayDensity,
    thinkingElapsedByEntryId: new Map()
  }))
}

function thinking(
  id: string,
  text: string,
  streaming = false,
  summary = true
): KernelThinkingEntry {
  return {
    id,
    kind: 'thinking',
    text,
    summary,
    timestamp: 1,
    streaming
  }
}
