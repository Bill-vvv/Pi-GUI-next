import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

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
import { sessionPinIdentity } from './session-pinning'
import { SessionHoverCard, useSessionHoverCard } from './SessionHoverCard'
import { SessionListBrowser } from './SessionListBrowser'
import type { SessionListQuery } from './session-list-query'
import {
  SessionSpinner,
  sessionAriaLabel
} from './ProjectNavigator'

export type TaskItem = {
  taskKey: string
  workspaceKey: string
  session: KernelState['sessions'][number]
}

type TaskListEntry = TaskItem & {
  key: string
  title: string
  lastActivityAt: number | null
}

type TaskNavigatorProps = {
  hidden: boolean
  tasks: TaskItem[]
  listQuery: SessionListQuery
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
  pinnedSessionIdentities: ReadonlySet<string>
  onTogglePinnedSession: (identity: string) => void
  onClearArchivedSessionPreview: () => void
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
  listQuery,
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
  pinnedSessionIdentities,
  onTogglePinnedSession,
  onClearArchivedSessionPreview,
  onActivateTask,
  onOpenSession,
  onArchiveSession
}: TaskNavigatorProps): React.JSX.Element {
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(() => new Set())
  const sessionHoverCard = useSessionHoverCard(hidden)
  const sessionActivityByIdentityRef = useRef(new Map<string, SessionActivitySnapshot>())

  useEffect(() => {
    const interval = window.setInterval(() => setActivityClock(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useLayoutEffect(() => {
    const observations: SessionActivityObservation[] = tasks.map(({ workspaceKey, session }) => ({
      identity: `${workspaceKey}\u0000${session.id}`,
      sessionKey: session.key,
      lastActivityAt: session.lastActivityAt,
      runtimeStatus: session.runtimeStatus
    }))
    const previousActivityByIdentity = sessionActivityByIdentityRef.current
    setUnreadSessionKeys((current) => reconcileUnreadSessionKeys(
      current,
      displayedSessionKey,
      previousActivityByIdentity,
      observations
    ))
    sessionActivityByIdentityRef.current = indexSessionActivity(observations)
  }, [displayedSessionKey, tasks])

  const orderedTasks = orderTaskItems(tasks)
  const listItems = useMemo<TaskListEntry[]>(
    () => orderedTasks
      .map((task, index) => ({
        ...task,
        key: task.session.key,
        title: task.session.name?.trim() || `任务 ${index + 1}`,
        lastActivityAt: task.session.lastActivityAt
      }))
      .filter(({ taskKey, session }) =>
        !pinnedSessionIdentities.has(sessionPinIdentity('task', taskKey, session.id))
      ),
    [orderedTasks, pinnedSessionIdentities]
  )
  const hoveredTask = sessionHoverCard.sessionKey === null
    ? null
    : listItems.find(({ session }) => session.key === sessionHoverCard.sessionKey) ?? null
  const retainedSessionKeys = useMemo(() => new Set(
    listItems
      .filter(({ session }) =>
        session.key === displayedSessionKey ||
        session.key === viewedSessionKey ||
        session.awaitingUserInput ||
        unreadSessionKeys.has(session.key) ||
        (session.runtimeStatus !== 'ready' && session.runtimeStatus !== 'stopped')
      )
      .map(({ session }) => session.key)
  ), [displayedSessionKey, listItems, unreadSessionKeys, viewedSessionKey])

  return (
    <>
      <section
      id="task-navigator-panel"
      className="sidebar-section project-list-section task-list-section"
      aria-labelledby="task-navigator-panel-toggle"
      aria-busy={contextActionStatus !== null}
      hidden={hidden}
    >
      {orderedTasks.length === 0 ? (
        <div className="empty-project-state task-empty-state">
          <span className="empty-project-state-icon" aria-hidden="true">
            <Icon name="messages" size="lg" />
          </span>
          <span className="empty-project-state-copy">
            <strong>还没有任务</strong>
            <span>新建一个不属于任何项目的独立任务</span>
          </span>
        </div>
      ) : (
        <SessionListBrowser
          listId="task-sessions"
          items={listItems}
          query={listQuery}
          now={activityClock}
          retainedKeys={retainedSessionKeys}
          resultNoun="任务"
          emptyLabel={orderedTasks.length === 0 ? '暂无任务。' : '任务已显示在置顶区域。'}
          noMatchLabel="没有匹配的任务。"
          renderItem={({ taskKey, workspaceKey, session, title }) => {
            const selected = session.key === displayedSessionKey
            const pinIdentity = sessionPinIdentity('task', taskKey, session.id)
            const presentedSession = session.name?.trim()
              ? session
              : { ...session, name: title }
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
                  aria-describedby={sessionHoverCard.describedBy(session.key)}
                  aria-busy={
                    (previewSelected && sessionPreviewPending) || session.runtimeStatus === 'starting'
                      ? true
                      : undefined
                  }
                  disabled={busy || (!activeWorkspace && !canChangeProjectOrSession)}
                  onFocus={(event) => sessionHoverCard.open(session.key, event.currentTarget)}
                  onBlur={sessionHoverCard.scheduleClose}
                  onPointerMove={(event) => sessionHoverCard.request(session.key, event.currentTarget)}
                  onPointerLeave={sessionHoverCard.scheduleClose}
                  onClick={() => {
                    if (busy) return
                    sessionHoverCard.dismiss()
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
                  <span className="session-title">{title}</span>
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
                  onPointerEnter={sessionHoverCard.dismiss}
                  onFocusCapture={sessionHoverCard.dismiss}
                >
                  {session.awaitingUserInput ? (
                    <span
                      className="session-awaiting-indicator"
                      role="status"
                      aria-label="等待你的回复"
                    >
                      <Icon name="question" size="sm" />
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
                      className="session-pin"
                      icon="pin"
                      label="置顶任务"
                      aria-pressed="false"
                      onClick={(event) => {
                        event.stopPropagation()
                        onTogglePinnedSession(pinIdentity)
                      }}
                    />
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
          }}
        />
      )}
      </section>
      <SessionHoverCard
        hidden={hidden}
        controller={sessionHoverCard}
        session={hoveredTask?.session ?? null}
        title={hoveredTask?.title ?? null}
        tokenCountFormat={tokenCountFormat}
        showSessionFile={false}
      />
    </>
  )
}

export function orderTaskItems(tasks: TaskItem[]): TaskItem[] {
  const tasksByIdentity = new Map<string, { task: TaskItem; index: number }>()
  tasks.forEach((task, index) => {
    const current = tasksByIdentity.get(task.taskKey)
    if (current === undefined) {
      tasksByIdentity.set(task.taskKey, { task, index })
      return
    }
    tasksByIdentity.set(task.taskKey, {
      task: preferredTaskItem(current.task, task),
      index: current.index
    })
  })

  const tasksBySessionIdentity = new Map<string, { task: TaskItem; index: number }>()
  for (const candidate of tasksByIdentity.values()) {
    const current = tasksBySessionIdentity.get(candidate.task.session.key)
    if (current === undefined) {
      tasksBySessionIdentity.set(candidate.task.session.key, candidate)
      continue
    }
    tasksBySessionIdentity.set(candidate.task.session.key, {
      task: preferredTaskItem(current.task, candidate.task),
      index: current.index
    })
  }

  return Array.from(tasksBySessionIdentity.values())
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

function preferredTaskItem(current: TaskItem, candidate: TaskItem): TaskItem {
  const currentPersisted = current.session.provisional !== true
  const candidatePersisted = candidate.session.provisional !== true
  if (currentPersisted !== candidatePersisted) return candidatePersisted ? candidate : current

  const currentBusy = isTaskBusy(current.session.runtimeStatus)
  const candidateBusy = isTaskBusy(candidate.session.runtimeStatus)
  if (currentBusy !== candidateBusy) return candidateBusy ? candidate : current

  return (candidate.session.lastActivityAt ?? 0) > (current.session.lastActivityAt ?? 0)
    ? candidate
    : current
}

function isTaskBusy(status: KernelState['runtime']['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping'
}
