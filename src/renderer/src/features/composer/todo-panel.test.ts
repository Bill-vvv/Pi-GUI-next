import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type { KernelTodoItem } from '../../../../shared/kernel-contract.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true }
})
after(async () => vite.close())

const todoPanelModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/composer/TodoPanel.tsx'
) as typeof import('./TodoPanel.tsx')
const { TodoPanel } = todoPanelModule
const timelineModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/Timeline.tsx'
) as typeof import('../chat/Timeline.tsx')
const { isTimelineEntryVisible } = timelineModule

const todos: KernelTodoItem[] = [
  { id: 'inspect', content: '检查 Composer', status: 'completed', priority: 'high' },
  { id: 'implement', content: '实现 Todo 面板', status: 'in_progress', priority: 'medium' },
  { id: 'verify', content: '运行验证', status: 'pending', priority: null },
  { id: 'old', content: '废弃旧方案', status: 'cancelled', priority: 'low' }
]

test('renders the compact Todo panel expanded with accessible disclosure state', () => {
  const html = renderToStaticMarkup(createElement(TodoPanel, { todos }))

  assert.match(html, /aria-label="当前任务"/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /1\/4/)
  assert.match(html, /composer-todo-state-icon active/)
  assert.match(html, /aria-label="正在处理"/)
  assert.match(html, /aria-current="step"/)
  assert.match(html, /composer-todo-item-index[^>]*>2</)
  assert.match(html, /实现 Todo 面板，进行中/)
  assert.match(html, /废弃旧方案，已取消/)
  assert.doesNotMatch(html, /composer-todo-item-status/)
  assert.doesNotMatch(html, /composer-todo-item-mark/)
})

test('the specialized Todo tool does not duplicate into the Timeline', () => {
  assert.equal(isTimelineEntryVisible({
    id: 'todo-tool',
    kind: 'tool',
    toolCallId: 'todo-tool',
    name: 'todowrite',
    status: 'success',
    args: '',
    output: '',
    details: '',
    truncated: false,
    timestamp: 1,
    durationMs: 1,
    subagent: null,
    todos
  }), false)
})

test('renders a settled status when no Todo remains pending or in progress', () => {
  const html = renderToStaticMarkup(createElement(TodoPanel, {
    todos: todos.map((todo) => ({ ...todo, status: 'completed' as const }))
  }))

  assert.match(html, /4\/4/)
  assert.match(html, /data-state="settled"/)
  assert.match(html, /composer-todo-state-icon settled/)
  assert.match(html, /aria-label="已完成"/)
})
