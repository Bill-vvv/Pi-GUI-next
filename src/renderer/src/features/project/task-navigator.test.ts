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
const workbenchCssSource = await readFile(
  new URL('../../composition/workbench.css', import.meta.url),
  'utf8'
)
const taskNavigatorSource = await readFile(
  new URL('./TaskNavigator.tsx', import.meta.url),
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

test('Task ordering keeps one persisted Session row per Task identity', () => {
  const persisted = task('same-task', 'ready', 10)
  const duplicateProvisional = task('same-task', 'running', 20)
  duplicateProvisional.session = {
    ...duplicateProvisional.session,
    key: '/tmp/wrong-project-session.jsonl',
    id: 'wrong-project-session',
    provisional: true
  }

  const ordered = orderTaskItems([duplicateProvisional, persisted])

  assert.equal(ordered.length, 1)
  assert.equal(ordered[0]?.session.key, persisted.session.key)
  assert.equal(ordered[0]?.session.provisional, undefined)
})

test('Task ordering does not project one Session identity through stale Task workspaces', () => {
  const staleReady = task('stale-ready', 'ready', 10)
  const staleRunning = task('stale-running', 'running', 20)
  staleReady.session = {
    ...staleReady.session,
    key: '/tmp/shared-wrong-session.jsonl',
    id: 'shared-wrong-session',
    provisional: true
  }
  staleRunning.session = { ...staleReady.session, runtimeStatus: 'running', lastActivityAt: 20 }

  const ordered = orderTaskItems([staleReady, staleRunning])

  assert.equal(ordered.length, 1)
  assert.equal(ordered[0]?.taskKey, 'stale-running')
})

test('Workbench exposes independent Project and Task disclosure groups', () => {
  assert.doesNotMatch(workbenchSource, /role="tablist"|role="tab"/)
  assert.doesNotMatch(workbenchSource, /onSelectNavigator|workspace-navigator-tabs/)
  assert.match(
    workbenchSource,
    /const \[projectNavigatorExpanded, setProjectNavigatorExpanded\] = useState\(true\)/
  )
  assert.match(
    workbenchSource,
    /const \[taskNavigatorExpanded, setTaskNavigatorExpanded\] = useState\(true\)/
  )
  assert.match(
    workbenchSource,
    /kind="project"[\s\S]*contentId="project-navigator-panel"[\s\S]*addLabel="添加项目"/
  )
  assert.match(
    workbenchSource,
    /kind="task"[\s\S]*contentId="task-navigator-panel"[\s\S]*addLabel="新建任务"/
  )
  assert.match(workbenchSource, /hidden=\{settingsOpen \|\| !projectNavigatorExpanded\}/)
  assert.match(workbenchSource, /hidden=\{settingsOpen \|\| !taskNavigatorExpanded\}/)
  assert.match(workbenchSource, /aria-expanded=\{expanded\}/)
  assert.match(workbenchSource, /aria-controls=\{contentId\}/)
  assert.match(
    workbenchSource,
    /className="workspace-navigator-group-action-slot"[\s\S]*className="workspace-navigator-group-add"/
  )
  assert.match(
    workbenchCssSource,
    /workspace-navigator-group-action-slot \{[\s\S]*margin-right: 0\.25rem;/
  )
  assert.match(
    workbenchCssSource,
    /data-kind='project'[\s\S]*workspace-navigator-group-add \{[\s\S]*opacity: 0;/
  )
  assert.match(
    workbenchCssSource,
    /workspace-navigator-group-action-slot:hover[\s\S]*workspace-navigator-group-add:not\(:disabled\)/
  )
  assert.doesNotMatch(workbenchSource, /className="add-project-entry/)
})

test('Task Navigator delegates task creation to the parent disclosure group', () => {
  assert.doesNotMatch(taskNavigatorSource, /task-empty-create|onCreateTask/)
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
    onActivateTask: () => Promise.resolve(),
    onOpenSession: () => {},
    onArchiveSession: () => Promise.resolve()
  }))

  assert.doesNotMatch(html, /role="tabpanel"/)
  assert.match(html, /aria-labelledby="task-navigator-panel-toggle"/)
  assert.match(html, />任务 1</)
  assert.doesNotMatch(html, /aria-label="新建任务"/)
  assert.doesNotMatch(html, /\/tmp\/task-1\.jsonl/)
})
