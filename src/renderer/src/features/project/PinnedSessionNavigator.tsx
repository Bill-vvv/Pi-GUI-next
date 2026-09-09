import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { KernelState } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { formatSessionActivityAge } from './session-activity-time'
import { sessionLifecycleLabel } from './session-lifecycle-presentation'
import {
  indexSessionActivity,
  reconcileUnreadSessionKeys,
  type SessionActivityObservation,
  type SessionActivitySnapshot
} from './session-unread-state'
import { SessionHoverCard, useSessionHoverCard } from './SessionHoverCard'
import {
  SessionSpinner,
  sessionAriaLabel
} from './ProjectNavigator'
import {
  isWorkbenchAction,
  type WorkbenchOperation
} from '../../workbench-actions'

export type PinnedSessionItem = {
  identity: string
  workspaceKind: 'project' | 'task'
  workspaceKey: string
  taskKey: string | null
  contextLabel: string
  title: string
  session: KernelState['sessions'][number]
}

type PinnedSessionNavigatorProps = {
  hidden: boolean
  items: PinnedSessionItem[]
  pinnedIdentities: readonly string[]
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
  onTogglePinnedSession: (identity: string) => void
  onClearArchivedSessionPreview: () => void
  onActivateProject: (projectKey: string) => Promise<void>
  onActivateTask: (taskKey: string, sessionKey: string) => Promise<void>
  onOpenSession: (
    sessionKey: string,
    runtimeStatus: KernelState['sessions'][number]['runtimeStatus']
  ) => void
  onArchiveSession: (sessionKey: string) => Promise<void>
}

export function PinnedSessionNavigator({
  hidden,
  items,
  pinnedIdentities,
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
  onTogglePinnedSession,
  onClearArchivedSessionPreview,
  onActivateProject,
  onActivateTask,
  onOpenSession,
  onArchiveSession
}: PinnedSessionNavigatorProps): React.JSX.Element | null {
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(() => new Set())
  const sessionHoverCard = useSessionHoverCard(hidden)
  const sessionActivityByIdentityRef = useRef(new Map<string, SessionActivitySnapshot>())
  const pinnedItems = selectPinnedSessionItems(items, pinnedIdentities)
  const hoveredItem = sessionHoverCard.sessionKey === null
    ? null
    : pinnedItems.find(({ session }) => session.key === sessionHoverCard.sessionKey) ?? null

  useEffect(() => {
    const interval = window.setInterval(() => setActivityClock(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useLayoutEffect(() => {
    const observations: SessionActivityObservation[] = items.map(({ identity, session }) => ({
      identity,
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
  }, [displayedSessionKey, items])

  if (pinnedItems.length === 0) return null

  const activateItem = async (item: PinnedSessionItem): Promise<boolean> => {
    if (item.workspaceKey === activeWorkspaceKey) return true
    if (!canChangeProjectOrSession) return false
    if (item.workspaceKind === 'task') {
      if (item.taskKey === null) return false
      await onActivateTask(item.taskKey, item.session.key)
      return false
    }
    await onActivateProject(item.workspaceKey)
    return true
  }

  return (
    <section
      className="pinned-session-section"
      aria-labelledby="pinned-session-heading"
      aria-busy={contextActionStatus !== null}
      hidden={hidden}
    >
      <div className="pinned-session-heading" id="pinned-session-heading">
        <span aria-hidden="true"><Icon name="pin-filled" size="sm" /></span>
        <span>置顶</span>
      </div>
      <div className="session-list pinned-session-list" aria-label={`置顶列表，共 ${pinnedItems.length} 条`}>
        {pinnedItems.map((item) => {
          const { session } = item
          const selected = session.key === displayedSessionKey
          const activeWorkspace = item.workspaceKey === activeWorkspaceKey
          const previewSelected = viewedSessionKey === session.key
          const lifecycleLabel = sessionLifecycleLabel(session.runtimeStatus)
          const unread = unreadSessionKeys.has(session.key)
          const activityLabel = formatSessionActivityAge(session.lastActivityAt, activityClock)
          const presentedSession = session.name?.trim()
            ? session
            : { ...session, name: item.title }
          const itemNoun = item.workspaceKind === 'task' ? '任务' : '对话'
          return (
            <div className={`session-row pinned-session-row${selected ? ' selected' : ''}`} key={item.identity}>
              <button
                className="session-item pinned-session-item"
                type="button"
                aria-label={`${sessionAriaLabel(presentedSession, tokenCountFormat)}。${item.contextLabel}`}
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
                    const shouldOpen = await activateItem(item)
                    if (shouldOpen) onOpenSession(session.key, session.runtimeStatus)
                  })().catch(() => undefined)
                }}
              >
                <span className="session-title">{item.title}</span>
                <span className="pinned-session-context">{item.contextLabel}</span>
                {session.requiresReload === true ? (
                  <span
                    className="session-reload-required"
                    role="status"
                    aria-label="需要重载"
                    data-tooltip={item.workspaceKind === 'task'
                      ? '凭证已变更，需要显式重载此任务'
                      : '凭证已变更，需要显式重载此对话'}
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
                  <span className="session-awaiting-indicator" role="status" aria-label="等待你的回复">
                    <Icon name="question" size="sm" />
                  </span>
                ) : lifecycleLabel !== null ? (
                  <SessionSpinner status={session.runtimeStatus} label={lifecycleLabel} />
                ) : unread ? (
                  <span className="session-unread-indicator" role="status" aria-label="有未读更新" />
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
                    className="session-pin pinned"
                    icon="pin-filled"
                    label={`取消置顶${itemNoun}`}
                    aria-pressed="true"
                    onClick={(event) => {
                      event.stopPropagation()
                      onTogglePinnedSession(item.identity)
                    }}
                  />
                  <IconButton
                    className="session-archive"
                    icon="archive"
                    label={`归档${itemNoun}`}
                    aria-busy={isWorkbenchAction(pendingAction, 'archive-session') ? true : undefined}
                    disabled={!canChangeProjectOrSession}
                    onClick={(event) => {
                      event.stopPropagation()
                      void (async () => {
                        if (viewingArchivedSession) onClearArchivedSessionPreview()
                        await activateItem(item)
                        await onArchiveSession(session.key)
                      })().catch(() => undefined)
                    }}
                  />
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <SessionHoverCard
        hidden={hidden}
        controller={sessionHoverCard}
        session={hoveredItem?.session ?? null}
        title={hoveredItem?.title ?? null}
        tokenCountFormat={tokenCountFormat}
        showSessionFile={hoveredItem?.workspaceKind !== 'task'}
      />
    </section>
  )
}

export function selectPinnedSessionItems(
  items: readonly PinnedSessionItem[],
  pinnedIdentities: readonly string[]
): PinnedSessionItem[] {
  const itemsByIdentity = new Map(items.map((item) => [item.identity, item]))
  const selected: PinnedSessionItem[] = []
  const seen = new Set<string>()
  for (const identity of pinnedIdentities) {
    if (seen.has(identity)) continue
    seen.add(identity)
    const item = itemsByIdentity.get(identity)
    if (item !== undefined) selected.push(item)
  }
  return selected
}
