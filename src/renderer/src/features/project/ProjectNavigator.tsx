import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { KernelState } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'

const COLLAPSED_SESSION_LIMIT = 5
const SESSION_SPINNER_DURATION_MS = 1_180

type ProjectHoverCardState = {
  projectKey: string
  top: number
  left: number
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
  const [expandedSessionProjectKeys, setExpandedSessionProjectKeys] = useState<Set<string>>(
    () => new Set()
  )
  const [projectHoverCard, setProjectHoverCard] = useState<ProjectHoverCardState | null>(null)
  const previousActiveProjectKeyRef = useRef(activeProjectKey)
  const sessionRunningByKeyRef = useRef(new Map<string, boolean>())
  const projectCardCloseTimerRef = useRef<number | null>(null)
  const sessionCountsByProjectRef = useRef(
    new Map(projects.map((project) => [project.path, project.sessionCount ?? 0]))
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
    setProjectHoverCard(null)
  }, [hidden])

  useEffect(() => {
    if (projectHoverCard === null) return
    const closeProjectCard = (): void => {
      if (projectCardCloseTimerRef.current !== null) {
        window.clearTimeout(projectCardCloseTimerRef.current)
        projectCardCloseTimerRef.current = null
      }
      setProjectHoverCard(null)
    }
    window.addEventListener('resize', closeProjectCard)
    window.addEventListener('scroll', closeProjectCard, true)
    return () => {
      window.removeEventListener('resize', closeProjectCard)
      window.removeEventListener('scroll', closeProjectCard, true)
      if (projectCardCloseTimerRef.current !== null) {
        window.clearTimeout(projectCardCloseTimerRef.current)
        projectCardCloseTimerRef.current = null
      }
    }
  }, [projectHoverCard])

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

  useEffect(() => {
    setUnreadSessionKeys((current) => {
      let next = current
      for (const summary of sessions) {
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
  }, [displayedSessionKey, sessions])

  const hoveredProject = projectHoverCard === null
    ? null
    : projects.find((project) => project.path === projectHoverCard.projectKey) ?? null

  const cancelProjectCardClose = (): void => {
    if (projectCardCloseTimerRef.current === null) return
    window.clearTimeout(projectCardCloseTimerRef.current)
    projectCardCloseTimerRef.current = null
  }

  const scheduleProjectCardClose = (): void => {
    cancelProjectCardClose()
    projectCardCloseTimerRef.current = window.setTimeout(() => {
      projectCardCloseTimerRef.current = null
      setProjectHoverCard(null)
    }, 120)
  }

  const openProjectCard = (projectKey: string, anchor: HTMLElement): void => {
    cancelProjectCardClose()
    const bounds = anchor.getBoundingClientRect()
    const width = 292
    const estimatedHeight = 224
    const left = bounds.right + 12
    if (left + width + 12 > window.innerWidth) {
      setProjectHoverCard(null)
      return
    }
    setProjectHoverCard({
      projectKey,
      left,
      top: Math.max(12, Math.min(bounds.top - 8, window.innerHeight - estimatedHeight - 12))
    })
  }

  return (
    <>
      <section
        className="sidebar-section project-list-section"
        aria-label="项目"
        aria-busy={contextActionStatus !== null}
        hidden={hidden}
      >
        {projects.length === 0 ? (
          <p className="empty-project-state muted" role="status">
            暂无项目。请使用侧边栏底部的“添加项目”。
          </p>
        ) : (
          projects.map((project) => {
            const selected = project.path === activeProjectKey
            const expanded = expandedProjectKeys.has(project.path)
            const projectLabel = basename(project.path) ?? project.path
            const projectSessions = project.sessions ?? (selected ? sessions : [])
            const busySessionCount = project.busySessionCount ?? projectSessions.filter((summary) => {
              const status = summary.runtimeStatus
              return status === 'running' || status === 'stopping'
            }).length
            const sessionListExpanded = expandedSessionProjectKeys.has(project.path)
            const visibleSessions = sessionListExpanded
              ? projectSessions
              : projectSessions.slice(0, COLLAPSED_SESSION_LIMIT)
            const hiddenSessionCount = projectSessions.length - COLLAPSED_SESSION_LIMIT
            const sessionListId = `project-sessions-${encodeURIComponent(project.path)}`
            return (
              <article
                className={`project-session-group${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}`}
                key={project.path}
              >
                <div
                  className={`project-row${draggedProjectKey === project.path ? ' dragging' : ''}${dragOverProjectKey === project.path ? ' drag-over' : ''}`}
                  onPointerEnter={(event) => openProjectCard(project.path, event.currentTarget)}
                  onPointerLeave={scheduleProjectCardClose}
                  onFocus={(event) => openProjectCard(project.path, event.currentTarget)}
                  onBlur={scheduleProjectCardClose}
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
                    disabled={!selected && !canChangeProjectOrSession}
                    onPointerDown={(event) => {
                      if (event.button === 0 && !busy && projects.length > 1) {
                        setDragArmedProjectKey(project.path)
                      }
                    }}
                    onClick={() => {
                      const expandingCollapsedSidebar = sidebarCollapsed
                      if (expandingCollapsedSidebar) {
                        cancelProjectCardClose()
                        setProjectHoverCard(null)
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
                  <IconButton
                    className="project-new-chat"
                    icon="plus"
                    label="在此项目中启动对话"
                    aria-busy={
                      pendingAction === 'start-session' ||
                      (!selected && pendingAction === 'activate-project')
                        ? true
                        : undefined
                    }
                    disabled={!canChangeProjectOrSession}
                    onClick={() => {
                      cancelProjectCardClose()
                      setProjectHoverCard(null)
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
                      const activityLabel = formatActivityAge(summary.lastActivityAt, activityClock)
                      return (
                        <div
                          className={`session-row${sessionSelected ? ' selected' : ''}`}
                          key={summary.key}
                        >
                          <button
                            className="session-item"
                            type="button"
                            data-tooltip={sessionTooltip(summary)}
                            data-tooltip-variant="mono"
                            aria-current={sessionSelected ? 'true' : undefined}
                            aria-busy={
                              (previewSelected && sessionPreviewPending) ||
                              (sessionSelected && sessionRuntimeStatus === 'starting')
                                ? true
                                : undefined
                            }
                            disabled={busy || (!selected && !canChangeProjectOrSession)}
                            onClick={() => {
                              if (busy) return
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
                    {hiddenSessionCount > 0 ? (
                      <button
                        className="session-list-toggle"
                        type="button"
                        aria-expanded={sessionListExpanded}
                        aria-controls={sessionListId}
                        onClick={() => setExpandedSessionProjectKeys((current) => {
                          const next = new Set(current)
                          if (next.has(project.path)) next.delete(project.path)
                          else next.add(project.path)
                          return next
                        })}
                      >
                        {sessionListExpanded
                          ? '收起多余对话'
                          : `展开其余 ${hiddenSessionCount} 个对话`}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )
          })
        )}
      </section>

      {hidden || hoveredProject === null || projectHoverCard === null ? null : createPortal(
        <aside
          className="project-hover-card"
          style={{ top: projectHoverCard.top, left: projectHoverCard.left }}
          aria-label={`${basename(hoveredProject.path) ?? hoveredProject.path} 项目信息`}
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
  return `对话 ${session.id.slice(0, 8)}`
}

function sessionTooltip(session: KernelState['sessions'][number]): string {
  const lines = [
    `文件：${session.key}`,
    `ID：${session.id}`
  ]
  const statistics = session.statistics
  if (statistics === null) {
    lines.push('统计：暂不可用')
    return lines.join('\n')
  }
  lines.push(
    `消息：${statistics.totalMessages.toLocaleString()}（用户 ${statistics.userMessages.toLocaleString()} / 助手 ${statistics.assistantMessages.toLocaleString()}）`,
    `Token 总量：${statistics.totalTokens.toLocaleString()}（输入 ${statistics.inputTokens.toLocaleString()} / 输出 ${statistics.outputTokens.toLocaleString()} / 缓存读取 ${statistics.cacheReadTokens.toLocaleString()} / 缓存写入 ${statistics.cacheWriteTokens.toLocaleString()}）`,
    `本对话累计（USD）：${formatUsd(statistics.cost)}`
  )
  return lines.join('\n')
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}

function formatActivityAge(timestamp: number | null, now: number): string | null {
  if (timestamp === null) return null
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (elapsedMinutes < 1) return '刚刚'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时`
  return `${Math.floor(elapsedHours / 24)} 天`
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
  const [animationDelay] = useState(
    () => `${-(Date.now() % SESSION_SPINNER_DURATION_MS)}ms`
  )
  return (
    <span
      className={`session-lifecycle-indicator ${status}`}
      role="status"
      aria-label={label}
    >
      <span
        className="session-spinner-visual"
        style={{ animationDelay }}
        aria-hidden="true"
      />
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
