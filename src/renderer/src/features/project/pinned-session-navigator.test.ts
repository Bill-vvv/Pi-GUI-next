import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type { KernelSessionSummary } from '../../../../shared/kernel-contract.ts'
import type { PinnedSessionItem } from './PinnedSessionNavigator.tsx'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true }
})
after(async () => vite.close())

const pinnedModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/project/PinnedSessionNavigator.tsx'
) as typeof import('./PinnedSessionNavigator.tsx')
const pinningModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/project/session-pinning.ts'
) as typeof import('./session-pinning.ts')
const { PinnedSessionNavigator, selectPinnedSessionItems } = pinnedModule
const { sessionPinIdentity } = pinningModule
const workbenchSource = await readFile(
  new URL('../../composition/Workbench.tsx', import.meta.url),
  'utf8'
)
const projectNavigatorSource = await readFile(
  new URL('./ProjectNavigator.tsx', import.meta.url),
  'utf8'
)

function session(key: string, name: string): KernelSessionSummary {
  return {
    key,
    id: key,
    name,
    lastActivityAt: 20,
    runtimeStatus: 'ready',
    awaitingUserInput: false,
    statistics: null
  }
}

function item(
  workspaceKind: 'project' | 'task',
  workspaceKey: string,
  title: string
): PinnedSessionItem {
  const summary = session(`/tmp/${title}.jsonl`, title)
  const taskKey = workspaceKind === 'task' ? `task-${title}` : null
  return {
    identity: sessionPinIdentity(workspaceKind, taskKey ?? workspaceKey, summary.id),
    workspaceKind,
    workspaceKey,
    taskKey,
    contextLabel: workspaceKind === 'task' ? '任务' : 'demo-project',
    title,
    session: summary
  }
}

test('Pinned Sessions keep their own persisted order independent of source ordering', () => {
  const projectSession = item('project', '/tmp/project', 'Project conversation')
  const taskSession = item('task', '/tmp/task', 'Standalone task')

  assert.deepEqual(
    selectPinnedSessionItems(
      [projectSession, taskSession],
      [taskSession.identity, projectSession.identity, taskSession.identity, 'stale']
    ).map(({ title }) => title),
    ['Standalone task', 'Project conversation']
  )
})

test('Pinned Sessions render above both workspace groups with direct unpin actions', () => {
  const projectSession = item('project', '/tmp/project', 'Project conversation')
  const taskSession = item('task', '/tmp/task', 'Standalone task')
  const html = renderToStaticMarkup(createElement(PinnedSessionNavigator, {
    hidden: false,
    items: [projectSession, taskSession],
    pinnedIdentities: [taskSession.identity, projectSession.identity],
    activeWorkspaceKey: '/tmp/project',
    displayedSessionKey: projectSession.session.key,
    viewedSessionKey: null,
    viewingArchivedSession: false,
    busy: false,
    canChangeProjectOrSession: true,
    sessionPreviewPending: false,
    pendingAction: null,
    contextActionStatus: null,
    tokenCountFormat: 'full',
    onTogglePinnedSession: () => {},
    onClearArchivedSessionPreview: () => {},
    onActivateProject: () => Promise.resolve(),
    onActivateTask: () => Promise.resolve(),
    onOpenSession: () => {},
    onArchiveSession: () => Promise.resolve()
  }))

  assert.match(html, /id="pinned-session-heading"[^>]*>[\s\S]*置顶/)
  assert.ok(html.indexOf('Standalone task') < html.indexOf('Project conversation'))
  assert.match(html, /aria-label="取消置顶任务"/)
  assert.match(html, /aria-label="取消置顶对话"/)
  assert.match(html, />demo-project</)
})

test('Workbench owns the local pin order and mounts it before Project and Task groups', () => {
  assert.match(workbenchSource, /PINNED_SESSIONS_STORAGE_KEY = 'pi-workbench\.pinned-sessions'/)
  assert.match(workbenchSource, /const \[pinnedSessionIdentities, setPinnedSessionIdentities\]/)
  assert.match(
    workbenchSource,
    /<PinnedSessionNavigator[\s\S]*<WorkspaceNavigatorGroup[\s\S]*kind="project"[\s\S]*<WorkspaceNavigatorGroup[\s\S]*kind="task"/
  )
  assert.match(projectNavigatorSource, /label="置顶对话"/)
  assert.match(projectNavigatorSource, /对话已显示在置顶区域。/)
})
