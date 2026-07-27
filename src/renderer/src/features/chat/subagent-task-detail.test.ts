import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type {
  KernelSubagentNoticeEntry,
  KernelSubagentParticipant,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true }
})
after(async () => vite.close())

const detailModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/SubagentTaskDetail.tsx'
) as typeof import('./SubagentTaskDetail.tsx')
const {
  SubagentTaskCapsule,
  SubagentTaskDetail,
  SubagentTaskInteractionContext
} = detailModule
const timelineModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/TimelineTurns.tsx'
) as typeof import('./TimelineTurns.tsx')
const { CompletedTurn, LiveTurn } = timelineModule

const workbenchSource = await readFile(
  new URL('../../composition/Workbench.tsx', import.meta.url),
  'utf8'
)
const workbenchStyles = await readFile(
  new URL('../../composition/workbench.css', import.meta.url),
  'utf8'
)
const chatStyles = await readFile(new URL('./chat.css', import.meta.url), 'utf8')

test('SubagentTaskCapsule SSR exposes button, selection and stable trigger identity', () => {
  const html = renderToStaticMarkup(createElement(SubagentTaskCapsule, {
    target: {
      kind: 'tool',
      toolCallId: 'subagent-call',
      participantIndex: 2
    },
    participant: participant(),
    selected: true,
    onClick: () => undefined
  }))

  assert.match(html, /^<button /)
  assert.match(html, /type="button"/)
  assert.match(html, /aria-label="查看 Subagent 任务：Review renderer"/)
  assert.match(html, /aria-pressed="true"/)
  assert.match(html, /aria-controls="subagent-task-detail"/)
  assert.match(html, /data-selected="true"/)
  assert.match(html, /data-subagent-task-kind="tool"/)
  assert.match(html, /data-subagent-tool-call-id="subagent-call"/)
  assert.match(html, /data-subagent-participant-index="2"/)
  assert.match(html, /subagent-run-chip-kind">Agent<\/span>/)
  assert.match(html, /subagent-run-chip-label">Review renderer<\/span>/)
})

test('a selected completed Subagent keeps its process expanded and capsule mounted', () => {
  const completed = participant({
    status: 'completed',
    finalOutput: 'Done.'
  })
  const html = renderToStaticMarkup(createElement(
    SubagentTaskInteractionContext.Provider,
    {
      value: {
        selection: {
          conversationIdentity: 'project:session',
          kind: 'tool',
          toolCallId: 'subagent-call',
          participantIndex: completed.index
        },
        onOpen: () => undefined
      }
    },
    createElement(CompletedTurn, {
      turn: {
        id: 'completed-turn',
        entries: [toolEntry(completed)]
      },
      toolDisplayDensity: 'standard',
      runElapsedMs: 2300,
      thinkingElapsedByEntryId: new Map()
    })
  ))

  assert.match(html, /<details class="completed-process" open="">/)
  assert.match(html, /data-subagent-tool-call-id="subagent-call"/)
  assert.match(html, /data-subagent-participant-index="2"/)
  assert.match(html, /aria-pressed="true"/)
})

test('pending and running Subagents stay visible outside the live process disclosure', () => {
  for (const toolDisplayDensity of ['compact', 'standard'] as const) {
    for (const status of ['pending', 'running'] as const) {
      const current = participant({ status })
      const html = renderToStaticMarkup(createElement(
        SubagentTaskInteractionContext.Provider,
        {
          value: {
            selection: null,
            onOpen: () => undefined
          }
        },
        createElement(LiveTurn, {
          turn: {
            id: `${toolDisplayDensity}:${status}`,
            entries: [
              {
                id: 'thinking:live',
                kind: 'thinking',
                text: 'Inspecting the request.',
                summary: false,
                timestamp: 1,
                streaming: true
              },
              toolEntry(current)
            ]
          },
          toolDisplayDensity,
          thinkingElapsedByEntryId: new Map()
        })
      ))

      assert.match(html, /data-subagent-tool-call-id="subagent-call"/)
      assert.match(html, /data-subagent-participant-index="2"/)
      assert.match(html, status === 'pending' ? /正在唤起/ : /运行中/)
      assert.doesNotMatch(html, /<details class="live-process-status"/)
    }
  }
})

test('Timeline keeps the Agent name on a clickable completion capsule without the result body', () => {
  const completionParticipant = participant({
    index: 0,
    agent: 'researcher',
    status: 'completed',
    task: '后台任务结果',
    finalOutput: 'Private completion preview that belongs in task detail.'
  })
  const completion: KernelSubagentNoticeEntry = {
    id: 'subagent-notice:completion',
    kind: 'subagent-notice',
    noticeType: 'completion',
    text: completionParticipant.finalOutput!,
    timestamp: 1,
    completion: completionParticipant
  }
  const html = renderToStaticMarkup(createElement(
    SubagentTaskInteractionContext.Provider,
    { value: { selection: null, onOpen: () => undefined } },
    createElement(CompletedTurn, {
      turn: { id: 'completion-turn', entries: [completion] },
      toolDisplayDensity: 'standard',
      runElapsedMs: null,
      thinkingElapsedByEntryId: new Map()
    })
  ))

  assert.match(html, /data-subagent-task-kind="notice"/)
  assert.match(html, /data-subagent-notice-id="subagent-notice:completion"/)
  assert.match(html, /aria-label="查看 Subagent 任务：researcher"/)
  assert.match(html, /subagent-run-chip-kind">Agent<\/span>/)
  assert.match(html, /subagent-run-chip-label">researcher<\/span>/)
  assert.doesNotMatch(html, />后台任务结果</)
  assert.match(html, />完成</)
  assert.doesNotMatch(html, /Private completion preview/)

  const detailHtml = renderToStaticMarkup(createElement(SubagentTaskDetail, {
    entry: completion,
    participant: completionParticipant,
    onClose: () => undefined
  }))
  assert.match(detailHtml, /Private completion preview/)
  assert.doesNotMatch(detailHtml, />用量</)

  const actionableHtml = renderToStaticMarkup(createElement(CompletedTurn, {
    turn: {
      id: 'request-turn',
      entries: [{
        ...completion,
        id: 'subagent-notice:request',
        noticeType: 'request',
        text: 'Reviewer needs a decision.',
        completion: undefined
      }]
    },
    toolDisplayDensity: 'standard',
    runElapsedMs: null,
    thinkingElapsedByEntryId: new Map()
  }))
  assert.match(actionableHtml, /Reviewer needs a decision\./)
})

test('Timeline renders supervisor coordination as a concise status lifecycle', () => {
  const pending: KernelSubagentNoticeEntry = {
    id: 'subagent-notice:request:request-1',
    kind: 'subagent-notice',
    noticeType: 'request',
    text: '请提供当前 Git 状态。',
    timestamp: 1,
    coordination: {
      runId: 'run-1',
      agent: 'explorer',
      participantIndex: 0,
      requestId: 'request-1',
      reason: 'need_decision',
      requiresReply: true,
      status: 'pending',
      resolvedAt: null
    }
  }
  const pendingHtml = renderToStaticMarkup(createElement(CompletedTurn, {
    turn: { id: 'request-turn', entries: [pending] },
    toolDisplayDensity: 'standard',
    runElapsedMs: null,
    thinkingElapsedByEntryId: new Map()
  }))

  assert.match(pendingHtml, /class="subagent-notice coordination attention pending"/)
  assert.match(pendingHtml, /role="status"/)
  assert.match(pendingHtml, /explorer 等待主代理/)
  assert.match(pendingHtml, /等待回复/)
  assert.match(pendingHtml, /请提供当前 Git 状态。/)
  assert.doesNotMatch(pendingHtml, /Reply with:/)
  assert.doesNotMatch(pendingHtml, /subagent_supervisor/)

  const handledHtml = renderToStaticMarkup(createElement(CompletedTurn, {
    turn: {
      id: 'handled-request-turn',
      entries: [{
        ...pending,
        coordination: {
          ...pending.coordination!,
          status: 'handled',
          resolvedAt: 2
        }
      }]
    },
    toolDisplayDensity: 'standard',
    runElapsedMs: null,
    thinkingElapsedByEntryId: new Map()
  }))
  assert.match(handledHtml, /class="subagent-notice coordination quiet handled"/)
  assert.match(handledHtml, /explorer 已获得所需信息/)
  assert.match(handledHtml, /已处理/)
  assert.doesNotMatch(handledHtml, /role="alert"/)
})

test('SubagentTaskDetail SSR renders normalized fields, controls and error before output', () => {
  const normalized = participant({
    status: 'failed',
    currentTool: 'read',
    currentPath: '/tmp/project/src/App.tsx',
    turnCount: 3,
    toolCount: 4,
    tokens: 1250,
    durationMs: 2300,
    error: '**Failure** <script>alert(1)</script>',
    finalOutput: '**stale output**'
  })
  const html = renderToStaticMarkup(createElement(SubagentTaskDetail, {
    entry: toolEntry(normalized),
    participant: normalized,
    onClose: () => undefined
  }))

  assert.match(html, /id="subagent-task-detail"/)
  assert.match(html, /tabindex="-1"/)
  assert.match(html, /aria-labelledby="subagent-task-detail-title"/)
  assert.match(html, /<button[^>]*>返回对话<\/button>/)
  assert.match(html, /aria-label="关闭 Subagent 任务详情"/)
  assert.match(html, /Review renderer/)
  assert.match(html, /<strong>reviewer<\/strong>/)
  assert.match(html, />失败</)
  assert.match(html, /<code>read<\/code>/)
  assert.match(html, /<code>\/tmp\/project\/src\/App\.tsx<\/code>/)
  assert.match(html, /<dt>轮次<\/dt><dd>3<\/dd>/)
  assert.match(html, /<dt>工具<\/dt><dd>4<\/dd>/)
  assert.match(html, /<dt>Token<\/dt><dd>1,250<\/dd>/)
  assert.match(html, /<dt>耗时<\/dt><dd>2\.3s<\/dd>/)
  assert.match(html, /role="alert"/)
  assert.match(html, /<strong>Failure<\/strong>/)
  assert.doesNotMatch(html, /stale output/)
  assert.doesNotMatch(html, /<script/)
})

test('SubagentTaskDetail SSR uses the safe Markdown pipeline for final output', () => {
  const completed = participant({
    status: 'completed',
    error: null,
    finalOutput: [
      '**Review complete.**',
      '',
      '![remote](https://example.com/image.png)',
      '',
      '<script>unsafe()</script>'
    ].join('\n')
  })
  const html = renderToStaticMarkup(createElement(SubagentTaskDetail, {
    entry: { ...toolEntry(completed), truncated: true },
    participant: completed,
    onClose: () => undefined
  }))

  assert.match(html, /<strong>Review complete\.<\/strong>/)
  assert.match(html, /markdown-image-link/)
  assert.match(html, /href="https:\/\/example\.com\/image\.png"/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, /<script/)
  assert.doesNotMatch(html, /unsafe\(\)/)
  assert.match(html, /工具输出已截断。/)
})

test('Workbench preserves Escape priority, locator focus restoration and responsive placement', () => {
  assert.match(
    workbenchSource,
    /if \(settingsOpen && event\.key === 'Escape'\)[\s\S]*?if \(subagentTaskSelection !== null && event\.key === 'Escape'\)/
  )
  assert.match(workbenchSource, /addEventListener\('keydown', handleShortcut, \{ capture: true \}\)/)
  assert.match(workbenchSource, /findSubagentTaskTrigger\(mainChat, selection\)/)
  assert.match(workbenchSource, /SUBAGENT_TASK_TRIGGER_SELECTOR/)
  assert.match(workbenchSource, /globalEscapeAbortEnabled=\{selectedSubagentTask === null\}/)
  assert.match(workbenchStyles, /\.app-shell\.subagent-detail-open \.main-chat \{\s*display: none;/)
  assert.match(workbenchStyles, /@media \(min-width: 1280px\)[\s\S]*?grid-template-columns:[\s\S]*?clamp\(20rem, 26vw, 25rem\)/)
  assert.match(workbenchStyles, /\.app-shell > \.subagent-task-detail \{\s*grid-column: 3;/)
  assert.match(chatStyles, /@media \(max-width: 1279px\)[\s\S]*?\.subagent-task-detail-back \{\s*display: inline-flex;/)
})

function participant(
  overrides: Partial<KernelSubagentParticipant> = {}
): KernelSubagentParticipant {
  return {
    index: 2,
    agent: 'reviewer',
    status: 'running',
    task: 'Review renderer',
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: null,
    finalOutput: null,
    ...overrides
  }
}

function toolEntry(current: KernelSubagentParticipant): KernelToolEntry {
  return {
    id: 'tool:subagent-call',
    kind: 'tool',
    toolCallId: 'subagent-call',
    name: 'subagent',
    status: current.status === 'failed'
      ? 'error'
      : current.status === 'completed' || current.status === 'paused' || current.status === 'detached'
        ? 'success'
        : current.status,
    args: '',
    output: '',
    details: '',
    truncated: false,
    timestamp: 1,
    durationMs: current.durationMs,
    subagent: {
      mode: 'single',
      runId: 'run-1',
      asyncId: null,
      participants: [current]
    }
  }
}
