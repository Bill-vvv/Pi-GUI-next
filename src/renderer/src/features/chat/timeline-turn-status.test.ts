import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type {
  KernelConversationEntry,
  KernelSubagentParticipant,
  KernelThinkingEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'
import { latestThinkingSummaryLabel } from './timeline-process-model.ts'

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
const {
  CompletedTurn,
  LiveTurn,
  ToolGroupExpandedContent
} = timelineModule
const detailModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/SubagentTaskDetail.tsx'
) as typeof import('./SubagentTaskDetail.tsx')
const { SubagentTaskInteractionContext } = detailModule

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
  assert.doesNotMatch(standardHtml, /<details class="live-process-status"/)

  const detailedHtml = renderLiveTurn([summary], 'detailed')
  assert.match(detailedHtml, />Tracing the display path</)
  assert.doesNotMatch(detailedHtml, />正在思考</)
  assert.doesNotMatch(detailedHtml, /process-thinking-detail/)
})

test('completed single-line thinking stays visible without a disclosure', () => {
  const html = renderToStaticMarkup(createElement(LiveTurn, {
    turn: {
      id: 'completed-short-thinking-turn',
      entries: [thinking('completed-short-thinking', '**The short conclusion stays visible**')]
    },
    toolDisplayDensity: 'detailed',
    thinkingElapsedByEntryId: new Map([['completed-short-thinking', 1_200]])
  }))

  assert.match(html, /process-thinking short/)
  assert.match(renderedText(html), /The short conclusion stays visible1\.2s/)
  assert.doesNotMatch(html, /<details class="process-thinking"/)
  assert.doesNotMatch(html, /process-thinking-summary/)
})

test('streaming Responses-style summary uses its latest line before the signature arrives', () => {
  const summary = thinking(
    'streaming-provisional-summary',
    '**Planning API data aggregation and analysis**\n\n**Defining concurrency and speed quartiles calculation**',
    true,
    false
  )

  const standardHtml = renderLiveTurn([summary])
  assert.match(standardHtml, />Defining concurrency and speed quartiles calculation</)
  assert.doesNotMatch(standardHtml, />正在思考</)
  assert.doesNotMatch(standardHtml, /Planning API data aggregation and analysis/)

  const detailedHtml = renderLiveTurn([summary], 'detailed')
  assert.match(detailedHtml, />Defining concurrency and speed quartiles calculation</)
  assert.doesNotMatch(detailedHtml, />正在思考</)
  assert.match(detailedHtml, /process-step thinking summary running/)
  assert.match(detailedHtml, /process-thinking-detail/)
  assert.match(detailedHtml, /Planning API data aggregation and analysis/)
})

test('adjacent thinking entries form one stage without repeating the active title', () => {
  const html = renderLiveTurn([
    thinking('thinking-first', '**Inspecting extension registration**'),
    thinking('thinking-second', '**Comparing load order**'),
    thinking('thinking-active', '**Preparing the loader fix**', true)
  ], 'detailed')

  assert.equal(html.match(/process-step thinking/g)?.length, 1)
  const text = renderedText(html)
  assert.equal(text.match(/Preparing the loader fix/g)?.length, 1)
  assert.ok(text.indexOf('Inspecting extension registration') < text.indexOf('Comparing load order'))
})

test('a newer live thinking stage replaces earlier thinking without hiding intervening output', () => {
  const entries: KernelConversationEntry[] = [
    thinking(
      'thinking-before-retry',
      '**Inspecting the first transport**\n\nThe first attempt is no longer active.',
      false,
      false
    ),
    tool('read-before-retry', 'read', 'success', { path: '/tmp/transport.ts' }),
    {
      id: 'retry-error',
      kind: 'error',
      title: 'CPA Responses WebSocket error',
      message: 'WebSocket closed before response.completed',
      source: 'agent',
      timestamp: 1
    },
    thinking('thinking-after-retry', '**Inspecting fallback priorities**', true)
  ]

  for (const density of ['standard', 'detailed'] as const) {
    const html = renderLiveTurn(entries, density)
    assert.doesNotMatch(html, /Inspecting the first transport/)
    assert.doesNotMatch(html, /The first attempt is no longer active/)
    assert.match(html, /Inspecting fallback priorities/)
    assert.match(html, /CPA Responses WebSocket error/)
    assert.match(html, /transport\.ts/)
  }
})

test('non-thinking process entries split thinking stages', () => {
  const html = renderLiveTurn([
    thinking('thinking-before-commentary', '**First stage**'),
    commentary('thinking-boundary-commentary', '先说明当前发现。'),
    thinking('thinking-before-tool', '**Second stage**'),
    tool('thinking-boundary-tool', 'read', 'success', { path: '/tmp/loader.ts' }),
    thinking('thinking-after-tool', '**Third stage**')
  ], 'detailed')

  assert.equal(html.match(/process-step thinking/g)?.length, 3)
})

test('completed adjacent thinking uses one disclosure and the longest complete observed span', () => {
  const html = renderToStaticMarkup(createElement(LiveTurn, {
    turn: {
      id: 'completed-thinking-group',
      entries: [
        thinking('thinking-duration-a', '**Inspecting registration**'),
        thinking('thinking-duration-b', '**Planning the fix**')
      ]
    },
    toolDisplayDensity: 'detailed',
    thinkingElapsedByEntryId: new Map([
      ['thinking-duration-a', 3_200],
      ['thinking-duration-b', 2_000]
    ])
  }))

  assert.equal(html.match(/process-step thinking/g)?.length, 1)
  assert.match(html, /<details class="process-thinking"/)
  assert.match(html, /process-thinking-title">思考了 3\.2s</)

  const incompleteHtml = renderToStaticMarkup(createElement(LiveTurn, {
    turn: {
      id: 'incomplete-thinking-duration-group',
      entries: [
        thinking('thinking-duration-known', '**Known duration**'),
        thinking('thinking-duration-missing', '**Missing duration**')
      ]
    },
    toolDisplayDensity: 'detailed',
    thinkingElapsedByEntryId: new Map([['thinking-duration-known', 1_200]])
  }))
  assert.match(incompleteHtml, /process-thinking-title">思考</)
  assert.doesNotMatch(incompleteHtml, /思考了/)
})

test('streaming narrative with ordinary prose keeps the generic thinking title', () => {
  const narrative = thinking(
    'streaming-narrative',
    '**Inspecting the current path**\n\nThe remaining paragraph is ordinary reasoning.',
    true,
    false
  )
  const html = renderLiveTurn([narrative], 'detailed')

  assert.match(html, />正在思考</)
  assert.match(html, /The remaining paragraph is ordinary reasoning\./)
})

test('active tools keep priority over the latest thinking summary', () => {
  const summary = thinking('streaming', '**Tracing the display path**', true)
  const currentTool = tool('read', 'read', 'running', { path: '/tmp/example.ts' })
  const toolHtml = renderLiveTurn([summary, currentTool])
  assert.match(renderedText(toolHtml), /正在读取 example\.ts/)
  assert.doesNotMatch(toolHtml, />Tracing the display path</)

  const compactHtml = renderLiveTurn([summary, currentTool], 'compact')
  assert.match(compactHtml, /thinking-status-code">example\.ts</)
})

test('standard density groups contiguous tools between commentary entries', () => {
  const html = renderLiveTurn([
    commentary('before', '先检查组件结构。'),
    tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
    tool('read-a-again', 'read', 'success', { path: '/tmp/a.ts', offset: 20 }),
    tool('read-b', 'read', 'success', { path: '/tmp/b.ts' }),
    thinking('hidden-summary', '**Checking the edited path**'),
    tool('edit-b', 'edit', 'success', { path: '/tmp/b.ts', edits: [{}] }),
    commentary('after', '接下来验证样式。'),
    tool('bash', 'bash', 'running', { command: 'pnpm typecheck' })
  ])

  const text = renderedText(html)
  assert.equal(html.match(/tool-group-summary standard/g)?.length, 2)
  assert.match(text, /读取 a\.ts、b\.ts，修改 b\.ts/)
  assert.match(text, /正在运行 1 条命令/)
  assert.ok(text.indexOf('先检查组件结构。') < text.indexOf('读取 a.ts、b.ts'))
  assert.ok(text.indexOf('读取 a.ts、b.ts') < text.indexOf('接下来验证样式。'))
  assert.ok(text.indexOf('接下来验证样式。') < text.indexOf('正在运行 1 条命令'))
  assert.match(html, /standard-tool-summary-action/)
  assert.match(html, /standard-tool-summary-detail code">a\.ts、b\.ts</)
  assert.match(html, /standard-tool-summary-detail meta">1 条命令</)
  assert.doesNotMatch(html, /tool-group-state|>完成<|>已阅读</)
})

test('single tool group expansion renders details without a repeated tool row', () => {
  const singleHtml = renderToStaticMarkup(createElement(ToolGroupExpandedContent, {
    entries: [tool('single-edit-detail', 'edit', 'running', {
      path: '/tmp/build_deck.py',
      edits: [{}]
    })]
  }))
  assert.match(singleHtml, /tool-group-single-detail/)
  assert.match(singleHtml, /process-tool-detail/)
  assert.doesNotMatch(singleHtml, /process-step-summary|tool-group-entries/)

  const multipleHtml = renderToStaticMarkup(createElement(ToolGroupExpandedContent, {
    entries: [
      tool('multiple-read', 'read', 'success', { path: '/tmp/a.ts' }),
      tool('multiple-edit', 'edit', 'running', { path: '/tmp/b.ts', edits: [{}] })
    ]
  }))
  assert.match(multipleHtml, /tool-group-entries/)
  assert.equal(multipleHtml.match(/process-step tool standard/g)?.length, 2)
})

test('tool command and raw targets use the code typography slot', () => {
  const commandHtml = renderLiveTurn([
    tool('bash-code-target', 'bash', 'running', { command: 'pnpm typecheck' })
  ], 'detailed')
  assert.match(commandHtml, /process-step-code-target">pnpm typecheck</)

  const queryHtml = renderLiveTurn([
    tool('search-code-target', 'grep', 'running', { query: 'font-family' })
  ], 'detailed')
  assert.match(queryHtml, /process-step-code-target">font-family</)
})

test('standard summary falls back to a file count when targets become noisy', () => {
  const html = renderLiveTurn([
    tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
    tool('read-b', 'read', 'success', { path: '/tmp/b.ts' }),
    tool('read-c', 'read', 'success', { path: '/tmp/c.ts' })
  ])

  assert.match(renderedText(html), /读取 3 个文件/)
  assert.match(html, /class="process-step-text"><span class="standard-tool-summary-action">读取<\/span>/)
  assert.match(html, /standard-tool-summary-detail meta">3 个文件</)
  assert.doesNotMatch(html, /class="process-step-text activity-text-shimmer"/)
  assert.doesNotMatch(html, /a\.ts、b\.ts、c\.ts/)
})

test('standard running composite tool summary shimmers as one activity line', () => {
  const html = renderLiveTurn([
    ...Array.from({ length: 6 }, (_, index) => (
      tool(`read-${index}`, 'read', 'success', { path: `/tmp/read-${index}.md` })
    )),
    tool('edit-running', 'edit', 'running', {
      path: '/tmp/创业沟通PPT_逐页定稿.md',
      edits: [{}]
    }),
    ...Array.from({ length: 4 }, (_, index) => (
      tool(`bash-${index}`, 'bash', 'success', { command: `printf ${index}` })
    ))
  ])

  assert.match(
    renderedText(html),
    /读取 6 个文件，正在修改 创业沟通PPT_逐页定稿\.md，运行 4 条命令/
  )
  assert.match(html, /class="process-step-text activity-text-shimmer"/)
})

test('standard running group keeps failures explicit', () => {
  const html = renderLiveTurn([
    commentary('before-failure', '开始执行工具。'),
    tool('read-failed', 'read', 'error', { path: '/tmp/missing.ts' }),
    tool('bash-running', 'bash', 'running', { command: 'pnpm build' })
  ])

  assert.match(renderedText(html), /读取 missing\.ts，正在运行 1 条命令1 项失败/)
  assert.match(html, /class="process-step-text activity-text-shimmer"/)
  assert.doesNotMatch(html, /tool-group-state|tool-group-failure-mark|>进行中</)
  assert.ok(html.indexOf('process-step-text') < html.indexOf('process-step-meta'))
})

test('completed process places its observed duration on the right', () => {
  const html = renderToStaticMarkup(createElement(CompletedTurn, {
    turn: {
      id: 'completed-observed-duration',
      entries: [
        userMessage('observed-user', '检查耗时', 1_000),
        commentary('observed-commentary', '正在检查。'),
        finalAnswer('observed-final', '已经完成。', 8_000)
      ]
    },
    toolDisplayDensity: 'standard',
    runElapsedMs: 3_200,
    thinkingElapsedByEntryId: new Map()
  }))

  assert.match(
    html,
    /completed-process-title">已处理<\/span><span class="completed-process-duration">3\.2s<\/span>/
  )
})

test('completed process falls back to the canonical turn timestamp span', () => {
  const html = renderToStaticMarkup(createElement(CompletedTurn, {
    turn: {
      id: 'completed-transcript-duration',
      entries: [
        userMessage('transcript-user', '检查历史耗时', 1_000),
        commentary('transcript-commentary', '正在恢复历史。'),
        finalAnswer('transcript-final', '恢复完成。', 6_200)
      ]
    },
    toolDisplayDensity: 'standard',
    runElapsedMs: null,
    thinkingElapsedByEntryId: new Map()
  }))

  assert.match(html, /completed-process-duration">5\.2s<\/span>/)
})

test('completed standard process shares grouping and keeps Subagents independent', () => {
  const participant = completedParticipant()
  const html = renderToStaticMarkup(createElement(
    SubagentTaskInteractionContext.Provider,
    {
      value: {
        selection: {
          conversationIdentity: 'project:session',
          kind: 'tool',
          toolCallId: 'subagent-call',
          participantIndex: participant.index
        },
        onOpen: () => undefined
      }
    },
    createElement(CompletedTurn, {
      turn: {
        id: 'completed-standard',
        entries: [
          commentary('completed-before', '先完成文件检查。'),
          tool('completed-read', 'read', 'success', { path: '/tmp/a.ts' }),
          tool('completed-edit', 'edit', 'success', { path: '/tmp/a.ts', edits: [{}] }),
          commentary('completed-after', '再交给 Subagent 复核。'),
          subagentTool(participant)
        ]
      },
      toolDisplayDensity: 'standard',
      runElapsedMs: 3200,
      thinkingElapsedByEntryId: new Map()
    })
  ))

  assert.match(html, /<details class="completed-process" open=""/)
  assert.match(renderedText(html), /读取 a\.ts，修改 a\.ts/)
  assert.equal(html.match(/tool-group-summary standard/g)?.length, 1)
  assert.match(html, /data-subagent-tool-call-id="subagent-call"/)
  assert.ok(html.indexOf('修改 1 个文件') < html.indexOf('data-subagent-tool-call-id'))
})

test('waiting status falls back when no usable summary exists', () => {
  const entries = [
    thinking('narrative', 'Full reasoning text', false, false),
    thinking('empty-summary', '   ')
  ]
  assert.equal(latestThinkingSummaryLabel(entries), null)
  assert.match(renderLiveTurn(entries), />正在继续</)
})

function renderedText(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

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

function commentary(id: string, text: string): KernelConversationEntry {
  return {
    id,
    kind: 'message',
    role: 'assistant',
    phase: 'commentary',
    text,
    timestamp: 1,
    streaming: false,
    stopReason: null,
    error: null
  }
}

function userMessage(id: string, text: string, timestamp: number): KernelConversationEntry {
  return {
    id,
    kind: 'message',
    role: 'user',
    phase: null,
    text,
    timestamp,
    streaming: false,
    stopReason: null,
    error: null
  }
}

function finalAnswer(id: string, text: string, timestamp: number): KernelConversationEntry {
  return {
    id,
    kind: 'message',
    role: 'assistant',
    phase: 'final_answer',
    text,
    timestamp,
    streaming: false,
    stopReason: 'stop',
    error: null
  }
}

function tool(
  id: string,
  name: string,
  status: KernelToolEntry['status'],
  args: Record<string, unknown>
): KernelToolEntry {
  return {
    id: `tool:${id}`,
    kind: 'tool',
    toolCallId: id,
    name,
    status,
    args: JSON.stringify(args),
    output: '',
    details: '',
    truncated: false,
    timestamp: 2,
    durationMs: null,
    subagent: null
  }
}

function completedParticipant(): KernelSubagentParticipant {
  return {
    index: 1,
    agent: 'reviewer',
    status: 'completed',
    task: '复核工具分组',
    model: null,
    usage: null,
    currentTool: null,
    currentPath: null,
    toolCount: 1,
    turnCount: 1,
    tokens: 100,
    durationMs: 500,
    error: null,
    finalOutput: '完成',
    outputReferences: []
  }
}

function subagentTool(participant: KernelSubagentParticipant): KernelToolEntry {
  return {
    ...tool('subagent-call', 'subagent', 'success', {}),
    subagent: {
      mode: 'single',
      runId: 'run-standard-group',
      asyncId: null,
      participants: [participant]
    }
  }
}
