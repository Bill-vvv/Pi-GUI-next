import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { KernelState } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import { formatUsd } from '../../format-usd'
import { formatSessionActivityAge } from './session-activity-time'
import {
  COLLAPSED_SESSION_LIMIT,
  nextVisibleSessionCountWithRetained,
  resolveVisibleSessionCount,
  selectVisibleSessions
} from './session-list-visibility'

/** Match TooltipProvider: only reveal after a deliberate hover dwell. */
const HOVER_CARD_SHOW_DELAY_MS = 600
const HOVER_CARD_CLOSE_DELAY_MS = 120

type ProjectHoverCardState = {
  projectKey: string
}

type SessionHoverCardState = {
  sessionKey: string
}

type ProjectNavigatorProps = {
  hidden: boolean
  projects: KernelState['projects']
  activeProjectKey: string | null
  sessions: KernelState['sessions']
  displayedSessionKey: string | null
  viewedSessionKey: string | null
  viewingArchivedSession: boolean
  sidebarCollapsed: boolean
  busy: boolean
  canChangeProjectOrSession: boolean
  sessionPreviewPending: boolean
  pendingAction: string | null
  contextActionStatus: string | null
  pinnedProjectKeys: Set<string>
  onTogglePinnedProject: (projectKey: string) => void
  onExpandSidebar: () => void
  onClearArchivedSessionPreview: () => void
  onActivateProject: (projectKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onOpenSession: (
    sessionKey: string,
    runtimeStatus: KernelState['sessions'][number]['runtimeStatus']
  ) => void
  onArchiveSession: (sessionKey: string) => Promise<void>
  onReorderProjects: (projectKeys: string[]) => Promise<void>
}

export function ProjectNavigator({
  hidden,
  projects,
  activeProjectKey,
  sessions,
  displayedSessionKey,
  viewedSessionKey,
  viewingArchivedSession,
  sidebarCollapsed,
  busy,
  canChangeProjectOrSession,
  sessionPreviewPending,
  pendingAction,
  contextActionStatus,
  pinnedProjectKeys,
  onTogglePinnedProject,
  onExpandSidebar,
  onClearArchivedSessionPreview,
  onActivateProject,
  onStartSession,
  onOpenSession,
  onArchiveSession,
  onReorderProjects
}: ProjectNavigatorProps): React.JSX.Element {
  const [dragArmedProjectKey, setDragArmedProjectKey] = useState<string | null>(null)
  const [draggedProjectKey, setDraggedProjectKey] = useState<string | null>(null)
  const [dragOverProjectKey, setDragOverProjectKey] = useState<string | null>(null)
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(() => new Set())
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(() =>
    activeProjectKey === null ? new Set() : new Set([activeProjectKey])
  )
  const [visibleSessionCountsByProject, setVisibleSessionCountsByProject] = useState<Map<string, number>>(
    () => new Map()
  )
  const [projectHoverCard, setProjectHoverCard] = useState<ProjectHoverCardState | null>(null)
  const [sessionHoverCard, setSessionHoverCard] = useState<SessionHoverCardState | null>(null)
  const projectHoverCardId = `${useId()}-project-information`
  const sessionHoverCardId = `${useId()}-session-information`
  const previousActiveProjectKeyRef = useRef(activeProjectKey)
  const sessionRunningByKeyRef = useRef(new Map<string, boolean>())
  const projectCardAnchorRef = useRef<HTMLElement>(null)
  const sessionCardAnchorRef = useRef<HTMLElement>(null)
  const projectCardCloseTimerRef = useRef<number | null>(null)
  const sessionCardCloseTimerRef = useRef<number | null>(null)
  const projectCardShowTimerRef = useRef<number | null>(null)
  const sessionCardShowTimerRef = useRef<number | null>(null)
  const pendingProjectKeyRef = useRef<string | null>(null)
  const pendingSessionKeyRef = useRef<string | null>(null)
  const sessionCountsByProjectRef = useRef(
    new Map(projects.map((project) => [project.path, project.sessionCount ?? 0]))
  )
  const { popoverRef: projectCardPopoverRef, position: projectCardPosition } =
    useViewportPopoverPosition<HTMLElement>(
      projectHoverCard !== null && !hidden,
      projectCardAnchorRef,
      224,
      { preferredWidth: 292, axis: 'horizontal' }
    )
  const { popoverRef: sessionCardPopoverRef, position: sessionCardPosition } =
    useViewportPopoverPosition<HTMLElement>(
      sessionHoverCard !== null && !hidden,
      sessionCardAnchorRef,
      360,
      { preferredWidth: 300, axis: 'horizontal' }
    )

  useEffect(() => {
    const interval = window.setInterval(() => setActivityClock(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    const disarmDrag = (): void => {
      setDragArmedProjectKey(null)
    }
    window.addEventListener('pointerup', disarmDrag)
    window.addEventListener('pointercancel', disarmDrag)
    return () => {
      window.removeEventListener('pointerup', disarmDrag)
      window.removeEventListener('pointercancel', disarmDrag)
    }
  }, [])

  useEffect(() => {
    for (const project of projects) {
      if (!sessionCountsByProjectRef.current.has(project.path)) {
        sessionCountsByProjectRef.current.set(project.path, project.sessionCount ?? 0)
      }
    }
    if (activeProjectKey !== null) {
      sessionCountsByProjectRef.current.set(activeProjectKey, sessions.length)
    }
  }, [activeProjectKey, projects, sessions.length])

  useEffect(() => {
    if (!hidden) return
    clearHoverCardTimers()
    setProjectHoverCard(null)
    setSessionHoverCard(null)
  }, [hidden])

  useEffect(() => {
    return () => {
      clearHoverCardTimers()
    }
  }, [])

  useEffect(() => {
    if (previousActiveProjectKeyRef.current === activeProjectKey) return
    previousActiveProjectKeyRef.current = activeProjectKey
    if (activeProjectKey === null) return
    setExpandedProjectKeys((current) => {
      if (current.has(activeProjectKey)) return current
      const next = new Set(current)
      next.add(activeProjectKey)
      return next
    })
  }, [activeProjectKey])

  useLayoutEffect(() => {
    const summariesByKey = new Map<string, KernelState['sessions'][number]>()
    for (const project of projects) {
      for (const summary of project.sessions ?? []) summariesByKey.set(summary.key, summary)
    }
    for (const summary of sessions) summariesByKey.set(summary.key, summary)

    setUnreadSessionKeys((current) => {
      let next = current
      for (const summary of summariesByKey.values()) {
        const status = summary.runtimeStatus
        const running = status === 'running'
        const wasRunning = sessionRunningByKeyRef.current.get(summary.key) === true

        if (wasRunning && status === 'ready' && summary.key !== displayedSessionKey) {
          if (!next.has(summary.key)) {
            next = new Set(next)
            next.add(summary.key)
          }
        } else if (summary.key === displayedSessionKey && next.has(summary.key)) {
          next = new Set(next)
          next.delete(summary.key)
        }

        sessionRunningByKeyRef.current.set(summary.key, running)
      }
      return next
    })
  }, [displayedSessionKey, projects, sessions])

  const hoveredProject = projectHoverCard === null
    ? null
    : projects.find((project) => project.path === projectHoverCard.projectKey) ?? null

  const hoveredSession = sessionHoverCard === null
    ? null
    : findSessionSummary(sessionHoverCard.sessionKey, projects, sessions, activeProjectKey)

  const cancelProjectCardClose = (): void => {
    if (projectCardCloseTimerRef.current === null) return
    window.clearTimeout(projectCardCloseTimerRef.current)
    projectCardCloseTimerRef.current = null
  }

  const cancelSessionCardClose = (): void => {
    if (sessionCardCloseTimerRef.current === null) return
    window.clearTimeout(sessionCardCloseTimerRef.current)
    sessionCardCloseTimerRef.current = null
  }

  const cancelProjectCardShow = (): void => {
    if (projectCardShowTimerRef.current !== null) {
      window.clearTimeout(projectCardShowTimerRef.current)
      projectCardShowTimerRef.current = null
    }
    pendingProjectKeyRef.current = null
  }

  const cancelSessionCardShow = (): void => {
    if (sessionCardShowTimerRef.current !== null) {
      window.clearTimeout(sessionCardShowTimerRef.current)
      sessionCardShowTimerRef.current = null
    }
    pendingSessionKeyRef.current = null
  }

  const clearHoverCardTimers = (): void => {
    cancelProjectCardClose()
    cancelSessionCardClose()
    cancelProjectCardShow()
    cancelSessionCardShow()
  }

  const dismissHoverCards = (): void => {
    clearHoverCardTimers()
    setProjectHoverCard(null)
    setSessionHoverCard(null)
  }

  const scheduleProjectCardClose = (): void => {
    cancelProjectCardShow()
    cancelProjectCardClose()
    projectCardCloseTimerRef.current = window.setTimeout(() => {
      projectCardCloseTimerRef.current = null
      setProjectHoverCard(null)
    }, HOVER_CARD_CLOSE_DELAY_MS)
  }

  const scheduleSessionCardClose = (): void => {
    cancelSessionCardShow()
    cancelSessionCardClose()
    sessionCardCloseTimerRef.current = window.setTimeout(() => {
      sessionCardCloseTimerRef.current = null
      setSessionHoverCard(null)
    }, HOVER_CARD_CLOSE_DELAY_MS)
  }

  const openProjectCard = (projectKey: string, anchor: HTMLElement): void => {
    projectCardAnchorRef.current = anchor
    cancelProjectCardShow()
    cancelProjectCardClose()
    cancelSessionCardShow()
    cancelSessionCardClose()
    setSessionHoverCard(null)
    if (projectHoverCard !== null && projectHoverCard.projectKey !== projectKey) {
      setProjectHoverCard(null)
      pendingProjectKeyRef.current = projectKey
      projectCardShowTimerRef.current = window.setTimeout(() => {
        if (pendingProjectKeyRef.current !== projectKey) return
        pendingProjectKeyRef.current = null
        projectCardShowTimerRef.current = null
        if (anchor.isConnected) setProjectHoverCard({ projectKey })
      }, 0)
      return
    }
    setProjectHoverCard({ projectKey })
  }

  const requestProjectCard = (projectKey: string, anchor: HTMLElement): void => {
    projectCardAnchorRef.current = anchor
    cancelProjectCardClose()
    cancelSessionCardShow()
    cancelSessionCardClose()
    setSessionHoverCard(null)

    if (projectHoverCard !== null && projectHoverCard.projectKey === projectKey) {
      cancelProjectCardShow()
      return
    }
    if (
      pendingProjectKeyRef.current === projectKey &&
      projectCardShowTimerRef.current !== null
    ) return

    if (projectHoverCard !== null) {
      setProjectHoverCard(null)
    }

    const activate = (): void => {
      if (pendingProjectKeyRef.current !== projectKey) return
      pendingProjectKeyRef.current = null
      projectCardShowTimerRef.current = null
      if (!anchor.isConnected) return
      openProjectCard(projectKey, anchor)
    }

    cancelProjectCardShow()
    pendingProjectKeyRef.current = projectKey
    projectCardShowTimerRef.current = window.setTimeout(activate, HOVER_CARD_SHOW_DELAY_MS)
  }

  const openSessionCard = (sessionKey: string, anchor: HTMLElement): void => {
    sessionCardAnchorRef.current = anchor
    cancelSessionCardShow()
    cancelSessionCardClose()
    cancelProjectCardShow()
    cancelProjectCardClose()
    setProjectHoverCard(null)
    if (sessionHoverCard !== null && sessionHoverCard.sessionKey !== sessionKey) {
      setSessionHoverCard(null)
      pendingSessionKeyRef.current = sessionKey
      sessionCardShowTimerRef.current = window.setTimeout(() => {
        if (pendingSessionKeyRef.current !== sessionKey) return
        pendingSessionKeyRef.current = null
        sessionCardShowTimerRef.current = null
        if (anchor.isConnected) setSessionHoverCard({ sessionKey })
      }, 0)
      return
    }
    setSessionHoverCard({ sessionKey })
  }

  const requestSessionCard = (sessionKey: string, anchor: HTMLElement): void => {
    sessionCardAnchorRef.current = anchor
    cancelSessionCardClose()
    cancelProjectCardShow()
    cancelProjectCardClose()
    setProjectHoverCard(null)

    if (sessionHoverCard !== null && sessionHoverCard.sessionKey === sessionKey) {
      cancelSessionCardShow()
      return
    }
    if (
      pendingSessionKeyRef.current === sessionKey &&
      sessionCardShowTimerRef.current !== null
    ) return

    if (sessionHoverCard !== null) {
      setSessionHoverCard(null)
    }

    const activate = (): void => {
      if (pendingSessionKeyRef.current !== sessionKey) return
      pendingSessionKeyRef.current = null
      sessionCardShowTimerRef.current = null
      if (!anchor.isConnected) return
      openSessionCard(sessionKey, anchor)
    }

    cancelSessionCardShow()
    pendingSessionKeyRef.current = sessionKey
    sessionCardShowTimerRef.current = window.setTimeout(activate, HOVER_CARD_SHOW_DELAY_MS)
  }

  useEffect(() => {
    const dismissOnOutsideClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      if (
        event.target.closest(
          '.project-row, .session-row, .project-hover-card, .session-hover-card'
        ) !== null
      ) return
      dismissHoverCards()
    }
    document.addEventListener('click', dismissOnOutsideClick, true)
    return () => document.removeEventListener('click', dismissOnOutsideClick, true)
  }, [])

  return (
    <>
      <section
        className="sidebar-section project-list-section"
        aria-label="项目"
        aria-busy={contextActionStatus !== null}
        hidden={hidden}
      >
        {projects.length === 0 ? (
          <div className="empty-project-state" role="status">
            <span className="empty-project-state-icon" aria-hidden="true">
              <Icon name="folder" size="lg" />
            </span>
            <span className="empty-project-state-copy">
              <strong>还没有项目</strong>
              <span>添加一个文件夹开始</span>
            </span>
          </div>
        ) : (
          projects.map((project) => {
            const selected = project.path === activeProjectKey
            const expanded = expandedProjectKeys.has(project.path)
            const pinned = pinnedProjectKeys.has(project.path)
            const projectLabel = basename(project.path) ?? project.path
            const projectSessions = project.sessions ?? (selected ? sessions : [])
            const busySessionCount = project.busySessionCount ?? projectSessions.filter((summary) => {
              const status = summary.runtimeStatus
              return status === 'running' || status === 'stopping'
            }).length
            const requestedVisibleSessionCount = visibleSessionCountsByProject.get(project.path)
            const visibleSessionCount = resolveVisibleSessionCount(
              projectSessions.length,
              requestedVisibleSessionCount
            )
            const sessionListExpanded = visibleSessionCount > COLLAPSED_SESSION_LIMIT
            const retainedSessionKeys = new Set(
              projectSessions
                .filter((summary) =>
                  summary.key === displayedSessionKey ||
                  summary.key === viewedSessionKey ||
                  summary.provisional === true ||
                  unreadSessionKeys.has(summary.key) ||
                  (summary.runtimeStatus !== 'ready' && summary.runtimeStatus !== 'stopped')
                )
                .map(({ key }) => key)
            )
            const visibleSessions = selectVisibleSessions(
              projectSessions,
              visibleSessionCount,
              retainedSessionKeys
            )
            const nextVisibleSessionCountValue = nextVisibleSessionCountWithRetained(
              projectSessions,
              requestedVisibleSessionCount,
              retainedSessionKeys
            )
            const nextVisibleSessions = selectVisibleSessions(
              projectSessions,
              nextVisibleSessionCountValue,
              retainedSessionKeys
            )
            const remainingSessionCount = projectSessions.length - visibleSessions.length
            const nextSessionRevealCount = nextVisibleSessions.length - visibleSessions.length
            const sessionListId = `project-sessions-${encodeURIComponent(project.path)}`
            return (
              <article
                className={`project-session-group${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}`}
                key={project.path}
              >
                <div
                  className={`project-row${draggedProjectKey === project.path ? ' dragging' : ''}${dragOverProjectKey === project.path ? ' drag-over' : ''}`}
                  draggable={!busy && projects.length > 1 && dragArmedProjectKey === project.path}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    setDraggedProjectKey(project.path)
                  }}
                  onDragOver={(event) => {
                    if (draggedProjectKey === null || draggedProjectKey === project.path) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDragOverProjectKey(project.path)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (draggedProjectKey === null || draggedProjectKey === project.path) return
                    const nextOrder = moveKey(
                      projects.map(({ path }) => path),
                      draggedProjectKey,
                      project.path
                    )
                    void onReorderProjects(nextOrder).catch(() => undefined)
                  }}
                  onDragEnd={() => {
                    setDragArmedProjectKey(null)
                    setDraggedProjectKey(null)
                    setDragOverProjectKey(null)
                  }}
                >
                  <button
                    className="project-select"
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    aria-expanded={expanded}
                    aria-describedby={
                      projectHoverCard?.projectKey === project.path && projectCardPosition !== null
                        ? projectHoverCardId
                        : undefined
                    }
                    disabled={!selected && !canChangeProjectOrSession}
                    onFocus={(event) => openProjectCard(project.path, event.currentTarget)}
                    onBlur={scheduleProjectCardClose}
                    onPointerMove={(event) => requestProjectCard(project.path, event.currentTarget)}
                    onPointerLeave={scheduleProjectCardClose}
                    onPointerDown={(event) => {
                      if (event.button === 0 && !busy && projects.length > 1) {
                        setDragArmedProjectKey(project.path)
                      }
                    }}
                    onClick={() => {
                      const expandingCollapsedSidebar = sidebarCollapsed
                      if (expandingCollapsedSidebar) {
                        dismissHoverCards()
                        onExpandSidebar()
                      }
                      if (viewingArchivedSession) onClearArchivedSessionPreview()
                      if (selected) {
                        if (expandingCollapsedSidebar) return
                        setExpandedProjectKeys((current) => {
                          const next = new Set(current)
                          if (next.has(project.path)) next.delete(project.path)
                          else next.add(project.path)
                          return next
                        })
                        return
                      }
                      if (!canChangeProjectOrSession) return
                      void onActivateProject(project.path)
                        .then(() => {
                          setExpandedProjectKeys((current) => {
                            if (current.has(project.path)) return current
                            const next = new Set(current)
                            next.add(project.path)
                            return next
                          })
                        })
                        .catch(() => undefined)
                    }}
                  >
                    <span className="project-icon" aria-hidden="true">
                      <Icon name={expanded ? 'folder-open' : 'folder'} size="sm" />
                    </span>
                    <span className="project-name">{projectLabel}</span>
                    {busySessionCount > 0 ? (
                      <span
                        className="project-activity-summary"
                        role="status"
                        aria-label={`有 ${busySessionCount} 个对话进行中`}
                        data-tooltip={`有 ${busySessionCount} 个对话进行中`}
                      >
                        <span className="project-activity-count" aria-hidden="true">
                          {busySessionCount}
                        </span>
                        <span className="project-activity-trace" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                      </span>
                    ) : null}
                    <span className="project-initial" aria-hidden="true">
                      {projectLabel.slice(0, 1).toLocaleUpperCase()}
                    </span>
                  </button>
                  <div
                    className="project-action-slot"
                    onPointerEnter={dismissHoverCards}
                    onFocusCapture={dismissHoverCards}
                    onPointerDown={(event) => {
                      if (event.button === 0) event.stopPropagation()
                    }}
                  >
                    <IconButton
                      className={`project-row-pin${pinned ? ' pinned' : ''}`}
                      icon={pinned ? 'pin-filled' : 'pin'}
                      label={pinned ? '取消置顶项目' : '置顶项目'}
                      aria-pressed={pinned}
                      draggable={false}
                      onClick={() => onTogglePinnedProject(project.path)}
                    />
                    <IconButton
                      className="project-new-chat"
                      icon="plus"
                      label="在此项目中启动对话"
                      draggable={false}
                      aria-busy={
                        pendingAction === 'start-session' ||
                        (!selected && pendingAction === 'activate-project')
                          ? true
                          : undefined
                      }
                      disabled={!canChangeProjectOrSession}
                      onClick={() => {
                        dismissHoverCards()
                        if (viewingArchivedSession) onClearArchivedSessionPreview()
                        void (async () => {
                          if (!selected) {
                            await onActivateProject(project.path)
                            setExpandedProjectKeys((current) => {
                              if (current.has(project.path)) return current
                              const next = new Set(current)
                              next.add(project.path)
                              return next
                            })
                          }
                          await onStartSession()
                        })().catch(() => undefined)
                      }}
                    />
                  </div>
                </div>

                {expanded ? (
                  <div className="session-list" id={sessionListId}>
                    {projectSessions.length === 0 ? (
                      <p className="empty-session-state muted">暂无对话。</p>
                    ) : visibleSessions.map((summary) => {
                      const sessionSelected = summary.key === displayedSessionKey
                      const previewSelected = viewedSessionKey === summary.key
                      const sessionRuntimeStatus = summary.runtimeStatus
                      const lifecycleLabel = sessionLifecycleLabel(sessionRuntimeStatus)
                      const unread = unreadSessionKeys.has(summary.key)
                      const activityLabel = formatSessionActivityAge(
                        summary.lastActivityAt,
                        activityClock
                      )
                      return (
                        <div
                          className={`session-row${sessionSelected ? ' selected' : ''}`}
                          key={summary.key}
                        >
                          <button
                            className="session-item"
                            type="button"
                            aria-label={sessionAriaLabel(summary)}
                            aria-current={sessionSelected ? 'true' : undefined}
                            aria-describedby={
                              sessionHoverCard?.sessionKey === summary.key && sessionCardPosition !== null
                                ? sessionHoverCardId
                                : undefined
                            }
                            aria-busy={
                              (previewSelected && sessionPreviewPending) ||
                              (sessionSelected && sessionRuntimeStatus === 'starting')
                                ? true
                                : undefined
                            }
                            disabled={busy || (!selected && !canChangeProjectOrSession)}
                            onFocus={(event) => openSessionCard(summary.key, event.currentTarget)}
                            onBlur={scheduleSessionCardClose}
                            onPointerMove={(event) => requestSessionCard(summary.key, event.currentTarget)}
                            onPointerLeave={scheduleSessionCardClose}
                            onClick={() => {
                              if (busy) return
                              dismissHoverCards()
                              void (async () => {
                                if (viewingArchivedSession) onClearArchivedSessionPreview()
                                if (!selected) {
                                  if (!canChangeProjectOrSession) return
                                  await onActivateProject(project.path)
                                  setExpandedProjectKeys((current) => {
                                    if (current.has(project.path)) return current
                                    const next = new Set(current)
                                    next.add(project.path)
                                    return next
                                  })
                                }
                                onOpenSession(summary.key, summary.runtimeStatus)
                              })().catch(() => undefined)
                            }}
                          >
                            <span className="session-title">{sessionTitle(summary)}</span>
                            {summary.requiresReload === true ? (
                              <span
                                className="session-reload-required"
                                role="status"
                                aria-label="需要重载"
                                data-tooltip="凭证已变更，需要显式重载此对话"
                              >
                                需重载
                              </span>
                            ) : null}
                          </button>
                          <div
                            className="session-action-slot"
                            data-tooltip={lifecycleLabel ?? (unread ? '有未读更新' : undefined)}
                            onPointerEnter={dismissHoverCards}
                            onFocusCapture={dismissHoverCards}
                          >
                            {lifecycleLabel !== null ? (
                              <SessionSpinner status={sessionRuntimeStatus} label={lifecycleLabel} />
                            ) : unread ? (
                              <span
                                className="session-unread-indicator"
                                role="status"
                                aria-label="有未读更新"
                              />
                            ) : activityLabel === null ? null : (
                              <time
                                className="session-last-active"
                                dateTime={new Date(summary.lastActivityAt ?? 0).toISOString()}
                              >
                                {activityLabel}
                              </time>
                            )}
                            <IconButton
                              className="session-archive"
                              icon="archive"
                              label="归档对话"
                              draggable={false}
                              aria-busy={pendingAction === 'archive-session' ? true : undefined}
                              disabled={!canChangeProjectOrSession}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.stopPropagation()
                                void (async () => {
                                  if (viewingArchivedSession) onClearArchivedSessionPreview()
                                  if (!selected) {
                                    await onActivateProject(project.path)
                                    setExpandedProjectKeys((current) => {
                                      if (current.has(project.path)) return current
                                      const next = new Set(current)
                                      next.add(project.path)
                                      return next
                                    })
                                  }
                                  await onArchiveSession(summary.key)
                                })().catch(() => undefined)
                              }}
                            />
                          </div>
                        </div>
                      )
                    })}
                    {projectSessions.length > COLLAPSED_SESSION_LIMIT ? (
                      <div className="session-list-actions" role="group" aria-label="对话列表显示数量">
                        {sessionListExpanded ? (
                          <button
                            className="session-list-toggle"
                            type="button"
                            aria-expanded="true"
                            aria-controls={sessionListId}
                            onClick={() => setVisibleSessionCountsByProject((current) => {
                              const next = new Map(current)
                              next.delete(project.path)
                              return next
                            })}
                          >
                            收起至 {COLLAPSED_SESSION_LIMIT} 个对话
                          </button>
                        ) : null}
                        {remainingSessionCount > 0 ? (
                          <button
                            className="session-list-toggle"
                            type="button"
                            aria-expanded={sessionListExpanded}
                            aria-controls={sessionListId}
                            onClick={() => setVisibleSessionCountsByProject((current) => {
                              const next = new Map(current)
                              next.set(
                                project.path,
                                nextVisibleSessionCountWithRetained(
                                  projectSessions,
                                  current.get(project.path),
                                  retainedSessionKeys
                                )
                              )
                              return next
                            })}
                          >
                            {sessionListExpanded ? '继续展开' : '展开更多'} {nextSessionRevealCount} 个对话
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })
        )}
      </section>

      {hidden || hoveredProject === null || projectHoverCard === null || projectCardPosition === null
        ? null
        : createPortal(
        <aside
          ref={projectCardPopoverRef}
          id={projectHoverCardId}
          className="project-hover-card"
          data-placement={projectCardPosition.placement}
          style={projectCardPosition.style}
          onPointerEnter={cancelProjectCardClose}
          onPointerLeave={scheduleProjectCardClose}
          onFocus={cancelProjectCardClose}
          onBlur={scheduleProjectCardClose}
        >
          <div className="project-hover-card-main">
            <div className="project-hover-card-heading">
              <span className="project-hover-card-folder" aria-hidden="true">
                <Icon name="folder-open" size="lg" />
              </span>
              <strong>{basename(hoveredProject.path) ?? hoveredProject.path}</strong>
              <button
                className={`project-pin-action${pinnedProjectKeys.has(hoveredProject.path) ? ' pinned' : ''}`}
                type="button"
                aria-label={pinnedProjectKeys.has(hoveredProject.path) ? '取消置顶项目' : '置顶项目'}
                aria-pressed={pinnedProjectKeys.has(hoveredProject.path)}
                data-tooltip={pinnedProjectKeys.has(hoveredProject.path) ? '取消置顶' : '置顶项目'}
                onClick={() => onTogglePinnedProject(hoveredProject.path)}
              >
                <Icon name={pinnedProjectKeys.has(hoveredProject.path) ? 'pin-filled' : 'pin'} />
              </button>
            </div>
            <div className="project-hover-card-stats">
              <div className="project-hover-stat">
                <span className="project-hover-stat-icon" aria-hidden="true">
                  <Icon name="messages" size="sm" />
                </span>
                <span>Session</span>
                <strong>{hoveredProject.sessions?.length ??
                  (hoveredProject.path === activeProjectKey
                    ? sessions.length
                    : sessionCountsByProjectRef.current.get(hoveredProject.path) ??
                      hoveredProject.sessionCount ?? 0)}</strong>
              </div>
              <div className="project-hover-stat">
                <span className="project-hover-stat-icon" aria-hidden="true">
                  <Icon name="unread" size="sm" />
                </span>
                <span>未读</span>
                <strong>{hoveredProject.unreadCount ?? 0}</strong>
              </div>
            </div>
          </div>
          <div className="project-hover-card-path">
            <span>项目路径</span>
            <code data-tooltip={hoveredProject.path} data-tooltip-variant="mono">
              {hoveredProject.path}
            </code>
          </div>
        </aside>,
        document.body
      )}

      {hidden || hoveredSession === null || sessionHoverCard === null || sessionCardPosition === null
        ? null
        : createPortal(
        <aside
          ref={sessionCardPopoverRef}
          id={sessionHoverCardId}
          className="session-hover-card"
          data-placement={sessionCardPosition.placement}
          style={sessionCardPosition.style}
          onPointerEnter={cancelSessionCardClose}
          onPointerLeave={scheduleSessionCardClose}
          onFocus={cancelSessionCardClose}
          onBlur={scheduleSessionCardClose}
        >
          <div className="session-hover-card-main">
            <div className="session-hover-card-heading">
              <span className="session-hover-card-icon" aria-hidden="true">
                <Icon name="messages" size="lg" />
              </span>
              <div className="session-hover-card-title-block">
                <strong>{sessionTitle(hoveredSession)}</strong>
                <code>{hoveredSession.id}</code>
              </div>
            </div>
            {hoveredSession.provisional === true ? (
              <p className="session-hover-card-status">创建中（尚未落盘，不可恢复）</p>
            ) : hoveredSession.statistics === null ? (
              <p className="session-hover-card-status">统计暂不可用</p>
            ) : (
              <dl className="session-hover-card-stats">
                <div className="session-hover-stat-row">
                  <dt>消息总计</dt>
                  <dd>{hoveredSession.statistics.totalMessages.toLocaleString()}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>用户 / 助手</dt>
                  <dd>
                    {hoveredSession.statistics.userMessages.toLocaleString()}
                    {' / '}
                    {hoveredSession.statistics.assistantMessages.toLocaleString()}
                  </dd>
                </div>
                <div className="session-hover-stat-row session-hover-stat-row-divider">
                  <dt>Token 总量</dt>
                  <dd>{hoveredSession.statistics.totalTokens.toLocaleString()}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>输入</dt>
                  <dd>{hoveredSession.statistics.inputTokens.toLocaleString()}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>输出</dt>
                  <dd>{hoveredSession.statistics.outputTokens.toLocaleString()}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>缓存读取</dt>
                  <dd>{hoveredSession.statistics.cacheReadTokens.toLocaleString()}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>缓存写入</dt>
                  <dd>{hoveredSession.statistics.cacheWriteTokens.toLocaleString()}</dd>
                </div>
                <div className="session-hover-stat-row session-hover-stat-row-divider">
                  <dt>费用（USD）</dt>
                  <dd>{formatUsd(hoveredSession.statistics.cost)}</dd>
                </div>
              </dl>
            )}
          </div>
          <div className="session-hover-card-path">
            <span>会话文件</span>
            <code data-tooltip={hoveredSession.key} data-tooltip-variant="mono">
              {hoveredSession.key}
            </code>
          </div>
        </aside>,
        document.body
      )}
    </>
  )
}

export function basename(path: string | null): string | null {
  if (path === null) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export function sessionTitle(session: KernelState['sessions'][number]): string {
  if (session.name !== null && session.name.trim().length > 0) return session.name
  if (session.provisional === true) return '新对话'
  return `对话 ${session.id.slice(0, 8)}`
}

function sessionAriaLabel(session: KernelState['sessions'][number]): string {
  const title = sessionTitle(session)
  if (session.provisional === true) {
    return `${title}。创建中，尚未落盘，不可恢复`
  }
  const statistics = session.statistics
  if (statistics === null) {
    return `${title}。统计暂不可用`
  }
  return [
    title,
    `消息 ${statistics.totalMessages.toLocaleString()}，用户 ${statistics.userMessages.toLocaleString()}，助手 ${statistics.assistantMessages.toLocaleString()}`,
    `Token ${statistics.totalTokens.toLocaleString()}，费用 ${formatUsd(statistics.cost)}`
  ].join('。')
}

function findSessionSummary(
  sessionKey: string,
  projects: KernelState['projects'],
  sessions: KernelState['sessions'],
  activeProjectKey: string | null
): KernelState['sessions'][number] | null {
  const fromActive = sessions.find((session) => session.key === sessionKey)
  if (fromActive !== undefined) return fromActive
  for (const project of projects) {
    if (project.path === activeProjectKey) continue
    const match = project.sessions?.find((session) => session.key === sessionKey)
    if (match !== undefined) return match
  }
  return null
}

function sessionLifecycleLabel(status: KernelState['runtime']['status']): string | null {
  if (status === 'starting') return '正在启动'
  if (status === 'running') return '正在处理'
  if (status === 'stopping') return '正在收尾'
  return null
}

function SessionSpinner({
  status,
  label
}: {
  status: KernelState['runtime']['status']
  label: string
}): React.JSX.Element {
  const visualRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const [animation] = visualRef.current?.getAnimations() ?? []
    // The document timeline is shared, so spinners mounted at different times keep one phase.
    if (animation !== undefined) animation.startTime = 0
  }, [])

  return (
    <span
      className={`session-lifecycle-indicator ${status}`}
      role="status"
      aria-label={label}
    >
      <span ref={visualRef} className="session-spinner-visual" aria-hidden="true" />
    </span>
  )
}

function moveKey(keys: string[], source: string, target: string): string[] {
  const sourceIndex = keys.indexOf(source)
  const targetIndex = keys.indexOf(target)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return keys
  const next = keys.slice()
  const [moved] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, moved)
  return next
}
