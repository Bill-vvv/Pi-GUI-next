import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { KernelState } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import {
  isWorkbenchAction,
  type WorkbenchOperation
} from '../../workbench-actions'
import { formatSessionActivityAge } from './session-activity-time'
import { sessionLifecycleLabel } from './session-lifecycle-presentation'
import {
  indexSessionActivity,
  reconcileUnreadSessionKeys,
  type SessionActivityObservation,
  type SessionActivitySnapshot
} from './session-unread-state'
import {
  COLLAPSED_SESSION_LIMIT,
  nextVisibleSessionCountWithRetained,
  resolveVisibleSessionCount,
  selectVisibleSessions
} from './session-list-visibility'
import {
  SessionSpinner,
  sessionAriaLabel
} from './ProjectNavigator'

export type TaskItem = {
  taskKey: string
  workspaceKey: string
  session: KernelState['sessions'][number]
}

type TaskNavigatorProps = {
  hidden: boolean
  tasks: TaskItem[]
  activeWorkspaceKey: string | null
  displayedSessionKey: string | null
  viewedSessionKey: string | null
  viewingArchivedSession: boolean
  busy: boolean
  canChangeProjectOrSession: boolean
  sessionPreviewPending: boolean
  pendingAction: WorkbenchOperation | null
  contextActionStatus: string | null
  tokenCountFormat: KernelState['appearance']['tokenCountFormat']
  onClearArchivedSessionPreview: () => void
  onCreateTask: () => Promise<void>
  onActivateTask: (taskKey: string, sessionKey: string) => Promise<void>
  onOpenSession: (
    sessionKey: string,
    runtimeStatus: KernelState['sessions'][number]['runtimeStatus']
  ) => void
  onArchiveSession: (sessionKey: string) => Promise<void>
}

export function TaskNavigator({
  hidden,
  tasks,
  activeWorkspaceKey,
  displayedSessionKey,
  viewedSessionKey,
  viewingArchivedSession,
  busy,
  canChangeProjectOrSession,
  sessionPreviewPending,
  pendingAction,
  contextActionStatus,
  tokenCountFormat,
  onClearArchivedSessionPreview,
  onCreateTask,
  onActivateTask,
  onOpenSession,
  onArchiveSession
}: TaskNavigatorProps): React.JSX.Element {
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(() => new Set())
  const [requestedVisibleCount, setRequestedVisibleCount] = useState<number | undefined>()
  const sessionActivityByIdentityRef = useRef(new Map<string, SessionActivitySnapshot>())

  useEffect(() => {
    const interval = window.setInterval(() => setActivityClock(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useLayoutEffect(() => {
    const observations: SessionActivityObservation[] = tasks.map(({ taskKey, session }) => ({
      identity: `${taskKey}\u0000${session.id}`,
      sessionKey: session.key,
      lastActivityAt: session.lastActivityAt
    }))
    setUnreadSessionKeys((current) => reconcileUnreadSessionKeys(
      current,
      displayedSessionKey,
      sessionActivityByIdentityRef.current,
      observations
    ))
    sessionActivityByIdentityRef.current = indexSessionActivity(observations)
  }, [displayedSessionKey, tasks])

  const orderedTasks = orderTaskItems(tasks)
  const retainedSessionKeys = new Set(
    orderedTasks
      .filter(({ session }) =>
        session.key === displayedSessionKey ||
        session.key === viewedSessionKey ||
        session.awaitingUserInput ||
        unreadSessionKeys.has(session.key) ||
        (session.runtimeStatus !== 'ready' && session.runtimeStatus !== 'stopped')
      )
      .map(({ session }) => session.key)
  )
  const requestedCount = resolveVisibleSessionCount(orderedTasks.length, requestedVisibleCount)
  const visibleSessions = selectVisibleSessions(
    orderedTasks.map(({ session }) => session),
    requestedCount,
    retainedSessionKeys
  )
  const tasksBySessionKey = new Map(orderedTasks.map((task) => [task.session.key, task]))
  const visibleTasks = visibleSessions.map((session) => tasksBySessionKey.get(session.key)!)
  const nextVisibleCount = nextVisibleSessionCountWithRetained(
    orderedTasks.map(({ session }) => session),
    requestedVisibleCount,
    retainedSessionKeys
  )
  const nextVisibleSessions = selectVisibleSessions(
    orderedTasks.map(({ session }) => session),
    nextVisibleCount,
    retainedSessionKeys
  )
  const remainingCount = orderedTasks.length - visibleTasks.length
  const nextRevealCount = nextVisibleSessions.length - visibleSessions.length
  const listExpanded = requestedCount > COLLAPSED_SESSION_LIMIT

  return (
    <section
      id="task-navigator-panel"
      className="sidebar-section project-list-section task-list-section"
      role="tabpanel"
      aria-labelledby="task-navigator-tab"
      aria-busy={contextActionStatus !== null}
      hidden={hidden}
    >
      <div className="task-list-heading">
        <strong>任务</strong>
        <IconButton
          className="task-create-button"
          icon="plus"
          label="新建任务"
          aria-busy={isWorkbenchAction(pendingAction, 'create-task') ||
            isWorkbenchAction(pendingAction, 'start-session') ? true : undefined}
          disabled={!canChangeProjectOrSession}
          onClick={() => void onCreateTask().catch(() => undefined)}
        />
      </div>

      {orderedTasks.length === 0 ? (
        <div className="empty-project-state task-empty-state">
          <span className="empty-project-state-icon" aria-hidden="true">
            <Icon name="messages" size="lg" />
          </span>
          <span className="empty-project-state-copy">
            <strong>还没有任务</strong>
            <span>新建一个不属于任何项目的独立任务</span>
          </span>
          <button
            className="task-empty-create"
            type="button"
            disabled={!canChangeProjectOrSession}
            onClick={() => void onCreateTask().catch(() => undefined)}
          >
            <Icon name="plus" size="control" />
            <span>新建任务</span>
          </button>
        </div>
      ) : (
        <div className="session-list task-session-list" id="task-sessions">
          {visibleTasks.map(({ taskKey, workspaceKey, session }) => {
            const selected = session.key === displayedSessionKey
            const taskTitle = session.name?.trim() ||
              `任务 ${orderedTasks.findIndex((task) => task.taskKey === taskKey) + 1}`
            const presentedSession = session.name?.trim()
              ? session
              : { ...session, name: taskTitle }
            const activeWorkspace = workspaceKey === activeWorkspaceKey
            const previewSelected = viewedSessionKey === session.key
            const lifecycleLabel = sessionLifecycleLabel(session.runtimeStatus)
            const unread = unreadSessionKeys.has(session.key)
            const activityLabel = formatSessionActivityAge(session.lastActivityAt, activityClock)
            return (
              <div className={`session-row${selected ? ' selected' : ''}`} key={taskKey}>
                <button
                  className="session-item"
                  type="button"
                  aria-label={sessionAriaLabel(presentedSession, tokenCountFormat)}
                  aria-current={selected ? 'true' : undefined}
                  aria-busy={
                    (previewSelected && sessionPreviewPending) || session.runtimeStatus === 'starting'
                      ? true
                      : undefined
                  }
                  disabled={busy || (!activeWorkspace && !canChangeProjectOrSession)}
                  onClick={() => {
                    if (busy) return
                    void (async () => {
                      if (viewingArchivedSession) onClearArchivedSessionPreview()
                      if (!activeWorkspace) {
                        if (!canChangeProjectOrSession) return
                        await onActivateTask(taskKey, session.key)
                        return
                      }
                      onOpenSession(session.key, session.runtimeStatus)
                    })().catch(() => undefined)
                  }}
                >
                  <span className="session-title">{taskTitle}</span>
                  {session.requiresReload === true ? (
                    <span
                      className="session-reload-required"
                      role="status"
                      aria-label="需要重载"
                      data-tooltip="凭证已变更，需要显式重载此任务"
                    >
                      需重载
                    </span>
                  ) : null}
                </button>
                <div
                  className="session-action-slot"
                  data-tooltip={
                    session.awaitingUserInput
                      ? '等待你的回复'
                      : lifecycleLabel ?? (unread ? '有未读更新' : undefined)
                  }
                >
                  {session.awaitingUserInput ? (
                    <span
                      className="session-awaiting-indicator"
                      role="status"
                      aria-label="等待你的回复"
                    >
                      ?
                    </span>
                  ) : lifecycleLabel !== null ? (
                    <SessionSpinner status={session.runtimeStatus} label={lifecycleLabel} />
                  ) : unread ? (
                    <span
                      className="session-unread-indicator"
                      role="status"
                      aria-label="有未读更新"
                    />
                  ) : activityLabel === null ? null : (
                    <time
                      className="session-last-active"
                      dateTime={new Date(session.lastActivityAt ?? 0).toISOString()}
                    >
                      {activityLabel}
                    </time>
                  )}
                  <div className="session-row-actions">
                    <IconButton
                      className="session-archive"
                      icon="archive"
                      label="归档任务"
                      aria-busy={isWorkbenchAction(pendingAction, 'archive-session') ? true : undefined}
                      disabled={!canChangeProjectOrSession}
                      onClick={(event) => {
                        event.stopPropagation()
                        void (async () => {
                          if (viewingArchivedSession) onClearArchivedSessionPreview()
                          if (!activeWorkspace) await onActivateTask(taskKey, session.key)
                          await onArchiveSession(session.key)
                        })().catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            )
          })}
          {orderedTasks.length > COLLAPSED_SESSION_LIMIT ? (
            <div className="session-list-actions" role="group" aria-label="任务列表显示数量">
              {listExpanded ? (
                <button
                  className="session-list-toggle"
                  type="button"
                  aria-expanded="true"
                  aria-controls="task-sessions"
                  onClick={() => setRequestedVisibleCount(undefined)}
                >
                  收起至 {COLLAPSED_SESSION_LIMIT} 个任务
                </button>
              ) : null}
              {remainingCount > 0 ? (
                <button
                  className="session-list-toggle"
                  type="button"
                  aria-expanded={listExpanded}
                  aria-controls="task-sessions"
                  onClick={() => setRequestedVisibleCount(nextVisibleCount)}
                >
                  展开更多 {nextRevealCount} 个任务
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

export function orderTaskItems(tasks: TaskItem[]): TaskItem[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const busyOrder = Number(isTaskBusy(right.task.session.runtimeStatus)) -
        Number(isTaskBusy(left.task.session.runtimeStatus))
      if (busyOrder !== 0) return busyOrder
      const activityOrder = (right.task.session.lastActivityAt ?? 0) -
        (left.task.session.lastActivityAt ?? 0)
      return activityOrder === 0 ? left.index - right.index : activityOrder
    })
    .map(({ task }) => task)
}

function isTaskBusy(status: KernelState['runtime']['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping'
}
