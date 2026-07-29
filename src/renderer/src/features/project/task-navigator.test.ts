import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type { KernelSessionSummary } from '../../../../shared/kernel-contract.ts'
import type { TaskItem } from './TaskNavigator.tsx'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true }
})
after(async () => vite.close())

const taskNavigatorModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/project/TaskNavigator.tsx'
) as typeof import('./TaskNavigator.tsx')
const { orderTaskItems, TaskNavigator } = taskNavigatorModule
const workbenchSource = await readFile(
  new URL('../../composition/Workbench.tsx', import.meta.url),
  'utf8'
)
const composerSource = await readFile(
  new URL('../composer/Composer.tsx', import.meta.url),
  'utf8'
)

function session(
  key: string,
  runtimeStatus: KernelSessionSummary['runtimeStatus'],
  lastActivityAt: number | null,
  awaitingUserInput = false
): KernelSessionSummary {
  return {
    key,
    id: key,
    name: null,
    lastActivityAt,
    runtimeStatus,
    awaitingUserInput,
    statistics: null
  }
}

function task(
  taskKey: string,
  runtimeStatus: KernelSessionSummary['runtimeStatus'],
  lastActivityAt: number | null
): TaskItem {
  return {
    taskKey,
    workspaceKey: `/var/lib/pi-gui-next/tasks/${taskKey}`,
    session: session(`/tmp/${taskKey}.jsonl`, runtimeStatus, lastActivityAt)
  }
}

test('Task ordering keeps active work first and otherwise follows recent activity', () => {
  const tasks = [
    task('older-ready', 'ready', 10),
    task('running', 'running', 1),
    task('newer-ready', 'ready', 20),
    task('starting', 'starting', null)
  ]

  assert.deepEqual(
    orderTaskItems(tasks).map(({ taskKey }) => taskKey),
    ['running', 'starting', 'newer-ready', 'older-ready']
  )
})

test('Workbench exposes mutually selected Project and Task tabs', () => {
  assert.match(workbenchSource, /role="tablist" aria-label="工作类型"/)
  assert.match(workbenchSource, /id="project-navigator-tab"[\s\S]*aria-selected=\{navigatorKind === 'project'\}/)
  assert.match(workbenchSource, /id="task-navigator-tab"[\s\S]*aria-selected=\{navigatorKind === 'task'\}/)
  assert.match(workbenchSource, /onSelectNavigator\('project'\)/)
  assert.match(workbenchSource, /onSelectNavigator\('task'\)/)
})

test('Task Composer disables Project-only path and generic Session creation capabilities', () => {
  assert.match(composerSource, /const taskWorkspace = activeWorkspace\?\.workspaceKind === 'task'/)
  assert.match(composerSource, /const projectPathFeaturesAvailable = !taskWorkspace/)
  assert.match(composerSource, /!taskWorkspace &&[\s\S]*!busy/)
})

test('Task Navigator gives pending ask replies priority over lifecycle and unread markers', () => {
  const awaitingTask = task('awaiting', 'running', 20)
  awaitingTask.session = session(awaitingTask.session.key, 'running', 20, true)
  const html = renderToStaticMarkup(createElement(TaskNavigator, {
    hidden: false,
    tasks: [awaitingTask],
    activeWorkspaceKey: awaitingTask.workspaceKey,
    displayedSessionKey: null,
    viewedSessionKey: null,
    viewingArchivedSession: false,
    busy: false,
    canChangeProjectOrSession: true,
    sessionPreviewPending: false,
    pendingAction: null,
    contextActionStatus: null,
    tokenCountFormat: 'full',
    onClearArchivedSessionPreview: () => {},
    onCreateTask: () => Promise.resolve(),
    onActivateTask: () => Promise.resolve(),
    onOpenSession: () => {},
    onArchiveSession: () => Promise.resolve()
  }))

  assert.match(html, /session-awaiting-indicator/)
  assert.match(html, /等待你的回复/)
  assert.doesNotMatch(html, /session-spinner-visual/)
  assert.doesNotMatch(html, /session-unread-indicator/)
})

test('Task Navigator exposes a flat task list without hidden workspace paths', () => {
  const html = renderToStaticMarkup(createElement(TaskNavigator, {
    hidden: false,
    tasks: [task('task-1', 'ready', 20)],
    activeWorkspaceKey: '/var/lib/pi-gui-next/tasks/task-1',
    displayedSessionKey: '/tmp/task-1.jsonl',
    viewedSessionKey: '/tmp/task-1.jsonl',
    viewingArchivedSession: false,
    busy: false,
    canChangeProjectOrSession: true,
    sessionPreviewPending: false,
    pendingAction: null,
    contextActionStatus: null,
    tokenCountFormat: 'full',
    onClearArchivedSessionPreview: () => {},
    onCreateTask: () => Promise.resolve(),
    onActivateTask: () => Promise.resolve(),
    onOpenSession: () => {},
    onArchiveSession: () => Promise.resolve()
  }))

  assert.match(html, /role="tabpanel"/)
  assert.match(html, />任务 1</)
  assert.match(html, /aria-label="新建任务"/)
  assert.doesNotMatch(html, /\/tmp\/task-1\.jsonl/)
})
