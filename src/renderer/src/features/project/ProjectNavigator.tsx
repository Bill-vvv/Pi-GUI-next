import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

import type { KernelState } from '../../../../shared/kernel-contract'
import {
  isWorkbenchAction,
  type WorkbenchOperation
} from '../../workbench-actions'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import { formatUsd } from '../../format-usd'
import { formatTokenCount } from '../../usage-formatters'
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

/** Match TooltipProvider: only reveal after a deliberate hover dwell. */
const HOVER_CARD_SHOW_DELAY_MS = 600
const HOVER_CARD_CLOSE_DELAY_MS = 120
const PROJECT_DRAG_START_DISTANCE_PX = 5

type ProjectDragGesture = {
  projectKey: string
  pointerId: number
  startX: number
  startY: number
  previewLeft: number
  previewWidth: number
  previewHeight: number
  previewPointerOffsetY: number
  initialOrder: string[]
  started: boolean
}

type ProjectDragPreviewState = {
  projectKey: string
  top: number
  left: number
  width: number
  height: number
}

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
  activeSessionKey: string | null
  sessions: KernelState['sessions']
  displayedSessionKey: string | null
  viewedSessionKey: string | null
  viewingArchivedSession: boolean
  sidebarCollapsed: boolean
  busy: boolean
  canChangeProjectOrSession: boolean
  sessionPreviewPending: boolean
  pendingAction: WorkbenchOperation | null
  contextActionStatus: string | null
  tokenCountFormat: KernelState['appearance']['tokenCountFormat']
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
  activeSessionKey,
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
  tokenCountFormat,
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
  const [draggedProjectKey, setDraggedProjectKey] = useState<string | null>(null)
  const [projectDragPreview, setProjectDragPreview] = useState<ProjectDragPreviewState | null>(null)
  const [projectOrderOverride, setProjectOrderOverride] = useState<string[] | null>(null)
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
  const sessionActivityByIdentityRef = useRef(new Map<string, SessionActivitySnapshot>())
  const projectListRef = useRef<HTMLElement>(null)
  const projectDragGestureRef = useRef<ProjectDragGesture | null>(null)
  const projectDragPreviewRef = useRef<HTMLDivElement>(null)
  const projectOrderOverrideRef = useRef<string[] | null>(null)
  const suppressedProjectClickRef = useRef<string | null>(null)
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
    const cancelDrag = (): void => {
      if (projectDragGestureRef.current === null) return
      projectDragGestureRef.current = null
      projectOrderOverrideRef.current = null
      setDraggedProjectKey(null)
      setProjectDragPreview(null)
      setProjectOrderOverride(null)
    }
    window.addEventListener('blur', cancelDrag)
    return () => window.removeEventListener('blur', cancelDrag)
  }, [])

  useEffect(() => {
    for (const project of projects) {
      if (!sessionCountsByProjectRef.current.has(project.path)) {
        sessionCountsByProjectRef.current.set(project.path, project.sessionCount ?? 0)
      }
    }
    if (activeProjectKey !== null) {
      const activeProject = projects.find(({ path }) => path === activeProjectKey)
      sessionCountsByProjectRef.current.set(
        activeProjectKey,
        activeProject?.sessionCount ?? activeProject?.sessions?.length ?? sessions.length
      )
    }
  }, [activeProjectKey, projects, sessions.length])

  useEffect(() => {
    if (!hidden) return
    clearHoverCardTimers()
    projectDragGestureRef.current = null
    projectOrderOverrideRef.current = null
    setDraggedProjectKey(null)
    setProjectDragPreview(null)
    setProjectOrderOverride(null)
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
    const observationsByKey = new Map<string, SessionActivityObservation>()
    for (const project of projects) {
      for (const summary of project.sessions ?? []) {
        observationsByKey.set(summary.key, {
          identity: sessionActivityIdentity(project.path, summary.id),
          sessionKey: summary.key,
          lastActivityAt: summary.lastActivityAt,
          runtimeStatus: summary.runtimeStatus
        })
      }
    }
    if (activeProjectKey !== null) {
      for (const summary of sessions) {
        observationsByKey.set(summary.key, {
          identity: sessionActivityIdentity(activeProjectKey, summary.id),
          sessionKey: summary.key,
          lastActivityAt: summary.lastActivityAt,
          runtimeStatus: summary.runtimeStatus
        })
      }
    }

    const observations = [...observationsByKey.values()]
    const previousActivityByIdentity = sessionActivityByIdentityRef.current
    setUnreadSessionKeys((current) => reconcileUnreadSessionKeys(
      current,
      displayedSessionKey,
      previousActivityByIdentity,
      observations
    ))
    sessionActivityByIdentityRef.current = indexSessionActivity(observations)
  }, [activeProjectKey, displayedSessionKey, projects, sessions])

  useEffect(() => {
    if (projectOrderOverride === null) return
    if (!isStrictProjectOrder(projects, projectOrderOverride)) {
      projectDragGestureRef.current = null
      projectOrderOverrideRef.current = null
      setDraggedProjectKey(null)
      setProjectDragPreview(null)
      setProjectOrderOverride(null)
      return
    }
    if (projectDragGestureRef.current !== null) return
    if (!sameOrder(projects.map(({ path }) => path), projectOrderOverride)) return
    projectOrderOverrideRef.current = null
    setProjectOrderOverride(null)
  }, [projectOrderOverride, projects])

  const orderedProjects = resolveProjectOrder(projects, projectOrderOverride)
  const draggedProject = projectDragPreview === null
    ? null
    : projects.find((project) => project.path === projectDragPreview.projectKey) ?? null

  const hoveredProject = projectHoverCard === null
    ? null
    : projects.find((project) => project.path === projectHoverCard.projectKey) ?? null
  const hoveredProjectSessions = hoveredProject?.sessions ?? (
    hoveredProject?.path === activeProjectKey ? sessions : []
  )
  const hoveredProjectUnreadCount = countUnreadSessions(
    hoveredProjectSessions,
    unreadSessionKeys
  )

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

  const updateProjectOrderOverride = (order: string[]): void => {
    projectOrderOverrideRef.current = order
    setProjectOrderOverride(order)
  }

  const clearProjectOrderOverride = (expectedOrder?: string[]): void => {
    if (
      expectedOrder !== undefined &&
      projectOrderOverrideRef.current !== expectedOrder
    ) return
    projectOrderOverrideRef.current = null
    setProjectOrderOverride(null)
  }

  const handleProjectPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectKey: string
  ): void => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      busy ||
      orderedProjects.length <= 1
    ) return
    const row = event.currentTarget.closest('.project-row')
    if (!(row instanceof HTMLElement)) return
    const bounds = row.getBoundingClientRect()
    projectDragGestureRef.current = {
      projectKey,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      previewLeft: bounds.left,
      previewWidth: bounds.width,
      previewHeight: bounds.height,
      previewPointerOffsetY: event.clientY - bounds.top,
      initialOrder: orderedProjects.map(({ path }) => path),
      started: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleProjectPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
    projectKey: string
  ): boolean => {
    const gesture = projectDragGestureRef.current
    if (
      gesture === null ||
      gesture.projectKey !== projectKey ||
      gesture.pointerId !== event.pointerId
    ) return false

    if (!gesture.started) {
      const deltaX = event.clientX - gesture.startX
      const deltaY = event.clientY - gesture.startY
      if (
        deltaX * deltaX + deltaY * deltaY <
        PROJECT_DRAG_START_DISTANCE_PX * PROJECT_DRAG_START_DISTANCE_PX
      ) return true
      gesture.started = true
      dismissHoverCards()
      updateProjectOrderOverride(gesture.initialOrder)
      setDraggedProjectKey(projectKey)
      setProjectDragPreview({
        projectKey,
        top: event.clientY - gesture.previewPointerOffsetY,
        left: gesture.previewLeft,
        width: gesture.previewWidth,
        height: gesture.previewHeight
      })
    }

    event.preventDefault()
    const previewTop = event.clientY - gesture.previewPointerOffsetY
    if (projectDragPreviewRef.current !== null) {
      projectDragPreviewRef.current.style.top = `${previewTop}px`
    } else {
      setProjectDragPreview((current) => current === null ? null : { ...current, top: previewTop })
    }

    const projectRows = Array.from(
      projectListRef.current?.querySelectorAll<HTMLElement>(
        '.project-session-group > .project-row'
      ) ?? []
    )
      .map((row) => {
        const group = row.closest<HTMLElement>('.project-session-group')
        if (group === null || group.dataset.projectKey === undefined) return null
        const bounds = row.getBoundingClientRect()
        return {
          key: group.dataset.projectKey,
          midpoint: bounds.top + bounds.height / 2
        }
      })
      .filter((row): row is { key: string; midpoint: number } => row !== null)
      .sort((left, right) => left.midpoint - right.midpoint)

    const stationaryRows = projectRows.filter(({ key }) => key !== projectKey)
    if (stationaryRows.length !== projects.length - 1) return true
    let insertionIndex = stationaryRows.length
    for (let index = 0; index < stationaryRows.length; index += 1) {
      if (event.clientY >= stationaryRows[index].midpoint) continue
      insertionIndex = index
      break
    }
    const nextOrder = stationaryRows.map(({ key }) => key)
    nextOrder.splice(insertionIndex, 0, projectKey)
    const currentOrder = projectOrderOverrideRef.current ?? gesture.initialOrder
    if (!sameOrder(currentOrder, nextOrder)) updateProjectOrderOverride(nextOrder)
    return true
  }

  const finishProjectPointerDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled: boolean
  ): void => {
    const gesture = projectDragGestureRef.current
    if (gesture === null || gesture.pointerId !== event.pointerId) return
    projectDragGestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture.started) return

    event.preventDefault()
    setDraggedProjectKey(null)
    setProjectDragPreview(null)
    const finalOrder = projectOrderOverrideRef.current ?? gesture.initialOrder
    if (cancelled || sameOrder(finalOrder, gesture.initialOrder)) {
      clearProjectOrderOverride()
      return
    }

    suppressedProjectClickRef.current = gesture.projectKey
    window.setTimeout(() => {
      if (suppressedProjectClickRef.current === gesture.projectKey) {
        suppressedProjectClickRef.current = null
      }
    }, 0)
    void onReorderProjects(finalOrder)
      .catch(() => undefined)
      .finally(() => clearProjectOrderOverride(finalOrder))
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
        id="project-navigator-panel"
        ref={projectListRef}
        className="sidebar-section project-list-section"
        aria-labelledby="project-navigator-panel-toggle"
        aria-busy={contextActionStatus !== null}
        data-reorder-enabled={!busy && orderedProjects.length > 1 ? 'true' : undefined}
        data-dragging={draggedProjectKey === null ? undefined : 'true'}
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
          projects.map((project, projectIndex) => {
            const selected = project.path === activeProjectKey
            const projectHighlighted = selected && activeSessionKey === null
            const expanded = expandedProjectKeys.has(project.path)
            const pinned = pinnedProjectKeys.has(project.path)
            const projectLabel = basename(project.path) ?? project.path
            const projectSessions = project.sessions ?? (selected ? sessions : [])
            const busySessionCount = project.busySessionCount ?? projectSessions.filter((summary) => {
              const status = summary.runtimeStatus
              return status === 'running' || status === 'stopping'
            }).length
            const awaitingUserInputCount = countAwaitingUserInput(projectSessions)
            const unreadSessionCount = countUnreadSessions(projectSessions, unreadSessionKeys)
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
                  summary.awaitingUserInput ||
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
                className={`project-session-group${projectHighlighted ? ' selected' : ''}${expanded ? ' expanded' : ''}${draggedProjectKey === project.path ? ' project-drag-placeholder' : ''}`}
                data-project-key={project.path}
                style={{
                  order: projectOrderOverride === null
                    ? projectIndex
                    : projectOrderOverride.indexOf(project.path)
                }}
                key={project.path}
              >
                <div className="project-row">
                  <button
                    className="project-select"
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    aria-expanded={expanded}
                    data-project-key={project.path}
                    aria-describedby={
                      projectHoverCard?.projectKey === project.path && projectCardPosition !== null
                        ? projectHoverCardId
                        : undefined
                    }
                    disabled={!selected && !canChangeProjectOrSession}
                    onFocus={(event) => openProjectCard(project.path, event.currentTarget)}
                    onBlur={scheduleProjectCardClose}
                    onPointerMove={(event) => {
                      if (handleProjectPointerMove(event, project.path)) return
                      requestProjectCard(project.path, event.currentTarget)
                    }}
                    onPointerLeave={scheduleProjectCardClose}
                    onPointerDown={(event) => handleProjectPointerDown(event, project.path)}
                    onPointerUp={(event) => finishProjectPointerDrag(event, false)}
                    onPointerCancel={(event) => finishProjectPointerDrag(event, true)}
                    onLostPointerCapture={(event) => finishProjectPointerDrag(event, true)}
                    onClick={(event) => {
                      if (suppressedProjectClickRef.current === project.path) {
                        suppressedProjectClickRef.current = null
                        event.preventDefault()
                        return
                      }
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
                    {awaitingUserInputCount > 0 && (!expanded || sidebarCollapsed) ? (
                      <span
                        className="project-awaiting-summary"
                        role="status"
                        aria-label={`有 ${awaitingUserInputCount} 个对话等待回复`}
                        data-tooltip={`有 ${awaitingUserInputCount} 个对话等待回复`}
                      >
                        <Icon name="question" size="sm" />
                      </span>
                    ) : busySessionCount > 0 ? (
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
                    {awaitingUserInputCount === 0 && unreadSessionCount > 0 && (!expanded || sidebarCollapsed) ? (
                      <span
                        className="project-unread-summary"
                        role="status"
                        aria-label={`有 ${unreadSessionCount} 个未读对话`}
                      />
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
                        isWorkbenchAction(pendingAction, 'start-session') ||
                        (!selected && isWorkbenchAction(pendingAction, 'activate-project'))
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
                            aria-label={sessionAriaLabel(summary, tokenCountFormat)}
                            aria-current={sessionSelected ? 'true' : undefined}
                            data-session-key={summary.key}
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
                            data-tooltip={
                              summary.awaitingUserInput
                                ? '等待你的回复'
                                : lifecycleLabel ?? (unread ? '有未读更新' : undefined)
                            }
                            onPointerEnter={dismissHoverCards}
                            onFocusCapture={dismissHoverCards}
                          >
                            {summary.awaitingUserInput ? (
                              <span
                                className="session-awaiting-indicator"
                                role="status"
                                aria-label="等待你的回复"
                              >
                                <Icon name="question" size="sm" />
                              </span>
                            ) : lifecycleLabel !== null ? (
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
                            <div className="session-row-actions">
                              <IconButton
                                className="session-archive"
                                icon="archive"
                                label="归档对话"
                                draggable={false}
                                aria-busy={isWorkbenchAction(pendingAction, 'archive-session') ? true : undefined}
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

      {hidden || projectDragPreview === null || draggedProject === null
        ? null
        : createPortal(
        <div
          ref={projectDragPreviewRef}
          className={`project-drag-preview${sidebarCollapsed ? ' collapsed' : ''}`}
          style={{
            top: projectDragPreview.top,
            left: projectDragPreview.left,
            width: projectDragPreview.width,
            height: projectDragPreview.height
          }}
          aria-hidden="true"
        >
          {sidebarCollapsed ? (
            <span className="project-initial">
              {(basename(draggedProject.path) ?? draggedProject.path).slice(0, 1).toLocaleUpperCase()}
            </span>
          ) : (
            <>
              <span className="project-icon">
                <Icon
                  name={expandedProjectKeys.has(draggedProject.path) ? 'folder-open' : 'folder'}
                  size="sm"
                />
              </span>
              <span className="project-name">
                {basename(draggedProject.path) ?? draggedProject.path}
              </span>
            </>
          )}
        </div>,
        document.body
      )}

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
                <strong>{hoveredProjectUnreadCount}</strong>
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
                  <dd>{formatTokenCount(hoveredSession.statistics.totalTokens, tokenCountFormat)}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>输入</dt>
                  <dd>{formatTokenCount(hoveredSession.statistics.inputTokens, tokenCountFormat)}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>输出</dt>
                  <dd>{formatTokenCount(hoveredSession.statistics.outputTokens, tokenCountFormat)}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>缓存读取</dt>
                  <dd>{formatTokenCount(hoveredSession.statistics.cacheReadTokens, tokenCountFormat)}</dd>
                </div>
                <div className="session-hover-stat-row">
                  <dt>缓存写入</dt>
                  <dd>{formatTokenCount(hoveredSession.statistics.cacheWriteTokens, tokenCountFormat)}</dd>
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

export function sessionAriaLabel(
  session: KernelState['sessions'][number],
  tokenCountFormat: KernelState['appearance']['tokenCountFormat']
): string {
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
    `Token ${formatTokenCount(statistics.totalTokens, tokenCountFormat)}，费用 ${formatUsd(statistics.cost)}`
  ].join('。')
}

function sessionActivityIdentity(projectPath: string, sessionId: string): string {
  return `${projectPath}\u0000${sessionId}`
}

function countAwaitingUserInput(sessions: KernelState['sessions']): number {
  let count = 0
  for (const session of sessions) {
    if (session.awaitingUserInput) count += 1
  }
  return count
}

function countUnreadSessions(
  sessions: KernelState['sessions'],
  unreadSessionKeys: ReadonlySet<string>
): number {
  let count = 0
  for (const session of sessions) {
    if (unreadSessionKeys.has(session.key)) count += 1
  }
  return count
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

export function SessionSpinner({
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

function resolveProjectOrder(
  projects: KernelState['projects'],
  order: string[] | null
): KernelState['projects'] {
  if (order === null || !isStrictProjectOrder(projects, order)) return projects
  const projectsByKey = new Map(projects.map((project) => [project.path, project]))
  return order.map((projectKey) => projectsByKey.get(projectKey)!)
}

function isStrictProjectOrder(
  projects: KernelState['projects'],
  order: string[]
): boolean {
  if (projects.length !== order.length) return false
  const projectKeys = new Set(projects.map(({ path }) => path))
  return order.every((projectKey) => projectKeys.delete(projectKey)) && projectKeys.size === 0
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}
