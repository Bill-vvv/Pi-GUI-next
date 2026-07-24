import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  AppearanceSettings,
  GeneralSettings,
  KernelExtensionSelectionKind,
  KernelInstalledPackage,
  KernelPiDevCatalog,
  KernelPromptAttachment,
  KernelProviderConfig,
  KernelProviderInput,
  KernelProviderTestResult,
  KernelSessionPreview,
  KernelState,
  SessionNamingSettings,
  ThinkingLevel
} from '../../../shared/kernel-contract'
import { Icon } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import { Composer } from '../features/composer/Composer'
import { SettingsPanel, type SettingsSection } from '../features/settings/SettingsPanel'
import { Timeline } from '../features/chat/Timeline'
import {
  DEFAULT_TOOL_DISPLAY_DENSITY,
  isToolDisplayDensity,
  type ToolDisplayDensity
} from '../tool-display-density'

const TOOL_DISPLAY_DENSITY_STORAGE_KEY = 'pi-workbench.tool-display-density'
const PINNED_PROJECTS_STORAGE_KEY = 'pi-workbench.pinned-projects'

type ProjectHoverCardState = {
  projectKey: string
  top: number
  left: number
}

type WorkbenchProps = {
  state: KernelState
  sessionPreview: KernelSessionPreview | null
  viewedSessionKey: string | null
  viewingNewSession: boolean
  newSessionPrepared: boolean
  sessionPreviewPending: boolean
  pendingAction: string | null
  completedAction: { action: string; succeeded: boolean } | null
  actionError: string | null
  systemFonts: string[] | null
  systemFontsError: string | null
  onAddProject: () => Promise<void>
  onActivateProject: (projectKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onWaitForSessionStart: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPreviewSession: (sessionKey: string) => Promise<void>
  onClearSessionPreview: () => void
  onArchiveSession: (sessionKey: string) => Promise<void>
  onReorderProjects: (projectKeys: string[]) => Promise<void>
  onReorderSessions: (sessionKeys: string[]) => Promise<void>
  onInstallExtension: (kind: KernelExtensionSelectionKind) => Promise<void>
  onRemoveExtension: (path: string) => Promise<void>
  onSearchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  onSearchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onRemovePiPackage: (source: string) => Promise<void>
  onUpdatePiPackage: (source: string) => Promise<void>
  onUpdatePiPackages: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  onListProviders: () => Promise<KernelProviderConfig[]>
  onSaveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  onRemoveProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  onTestProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
  onSelectPromptAttachments: () => Promise<KernelPromptAttachment[]>
  onPrompt: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onSteer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onFollowUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettings) => Promise<void>
  onSetAppearance: (settings: AppearanceSettings) => Promise<void>
}

export function Workbench({
  state,
  sessionPreview,
  viewedSessionKey,
  viewingNewSession,
  newSessionPrepared,
  sessionPreviewPending,
  pendingAction,
  completedAction,
  actionError,
  systemFonts,
  systemFontsError,
  onAddProject,
  onActivateProject,
  onStartSession,
  onWaitForSessionStart,
  onActivateSession,
  onPreviewSession,
  onClearSessionPreview,
  onArchiveSession,
  onReorderProjects,
  onReorderSessions,
  onInstallExtension,
  onRemoveExtension,
  onSearchPiDevExtensions,
  onSearchPiDevPackages,
  onListPiPackages,
  onInstallPiDevPackage,
  onRemovePiPackage,
  onUpdatePiPackage,
  onUpdatePiPackages,
  onOpenExternal,
  onListProviders,
  onSaveProvider,
  onRemoveProvider,
  onTestProvider,
  onSelectPromptAttachments,
  onPrompt,
  onSteer,
  onFollowUp,
  onInvokeCommand,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
  onSetSessionNaming,
  onSetGeneral,
  onSetAppearance
}: WorkbenchProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [toolDisplayDensity, setToolDisplayDensity] = useState<ToolDisplayDensity>(() => {
    const stored = window.localStorage.getItem(TOOL_DISPLAY_DENSITY_STORAGE_KEY)
    return isToolDisplayDensity(stored) ? stored : DEFAULT_TOOL_DISPLAY_DENSITY
  })
  const [dragArmedProjectKey, setDragArmedProjectKey] = useState<string | null>(null)
  const [draggedProjectKey, setDraggedProjectKey] = useState<string | null>(null)
  const [dragOverProjectKey, setDragOverProjectKey] = useState<string | null>(null)
  const [dragArmedSessionKey, setDragArmedSessionKey] = useState<string | null>(null)
  const [draggedSessionKey, setDraggedSessionKey] = useState<string | null>(null)
  const [dragOverSessionKey, setDragOverSessionKey] = useState<string | null>(null)
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(() => new Set())
  const [expandedProjectKey, setExpandedProjectKey] = useState<string | null>(
    () => state.activeProjectKey
  )
  const [pinnedProjectKeys, setPinnedProjectKeys] = useState<Set<string>>(() => {
    try {
      const stored: unknown = JSON.parse(
        window.localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY) ?? '[]'
      )
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string =>
        typeof value === 'string'
      ) : [])
    } catch {
      return new Set()
    }
  })
  const [projectHoverCard, setProjectHoverCard] = useState<ProjectHoverCardState | null>(null)
  const {
    projects,
    activeProjectKey,
    sessions,
    activeSessionKey,
    runtime,
    conversation
  } = state
  const previousActiveProjectKeyRef = useRef(activeProjectKey)
  const sessionRunningByKeyRef = useRef(new Map<string, boolean>())
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const restoreSettingsFocusRef = useRef(false)
  const settingsActionRef = useRef<string | null>(null)
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
      setDragArmedSessionKey(null)
    }
    window.addEventListener('pointerup', disarmDrag)
    window.addEventListener('pointercancel', disarmDrag)
    return () => {
      window.removeEventListener('pointerup', disarmDrag)
      window.removeEventListener('pointercancel', disarmDrag)
    }
  }, [])
  useEffect(() => {
    if (settingsOpen || !restoreSettingsFocusRef.current) return
    restoreSettingsFocusRef.current = false
    settingsButtonRef.current?.focus()
  }, [settingsOpen])
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
    if (!settingsOpen) return
    setProjectHoverCard(null)
  }, [settingsOpen])
  useEffect(() => () => {
    if (projectCardCloseTimerRef.current !== null) {
      window.clearTimeout(projectCardCloseTimerRef.current)
    }
  }, [])
  // 仅在切换到另一个 Project 时自动展开；当前 Project 的展开/收起由点击切换，不被强制回写。
  useEffect(() => {
    if (previousActiveProjectKeyRef.current === activeProjectKey) return
    previousActiveProjectKeyRef.current = activeProjectKey
    setExpandedProjectKey(activeProjectKey)
  }, [activeProjectKey])
  const displayedProjects = projects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      const pinOrder = Number(pinnedProjectKeys.has(right.project.path)) -
        Number(pinnedProjectKeys.has(left.project.path))
      return pinOrder === 0 ? left.index - right.index : pinOrder
    })
    .map(({ project }) => project)
  const activeProject = activeProjectKey === null
    ? null
    : projects.find((project) => project.path === activeProjectKey) ?? null
  const hoveredProject = projectHoverCard === null
    ? null
    : projects.find((project) => project.path === projectHoverCard.projectKey) ?? null
  const displayedSessionKey = viewingNewSession
    ? null
    : viewedSessionKey ?? activeSessionKey
  const viewingInactiveSession =
    viewedSessionKey !== null && viewedSessionKey !== activeSessionKey
  const activeSession = displayedSessionKey === null
    ? null
    : sessions.find((summary) => summary.key === displayedSessionKey) ?? null
  useEffect(() => {
    setUnreadSessionKeys((current) => {
      let next = current
      for (const summary of sessions) {
        const status = summary.key === activeSessionKey ? runtime.status : summary.runtimeStatus
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
  }, [activeSessionKey, displayedSessionKey, runtime.status, sessions])
  const projectName = basename(activeProject?.path ?? null) ?? '未选择项目'
  const busy = pendingAction !== null
  const canChangeProjectOrSession = !busy
  const canStartSession =
    canChangeProjectOrSession &&
    activeProject !== null
  const contextActionStatus = sessionPreviewPending
    ? '正在读取对话…'
    : runtimeContextActionStatus(pendingAction)
  const displayedConversation = viewingNewSession && !newSessionPrepared
    ? { entries: [], activeRunStartIndex: null }
    : sessionPreview?.conversation ?? (
        viewingInactiveSession ? { entries: [], activeRunStartIndex: null } : conversation
      )
  const extensionActionError = completedAction !== null &&
    !completedAction.succeeded &&
    (completedAction.action === 'install-extension' || completedAction.action === 'remove-extension')
    ? actionError
    : null
  const failedAction = actionError !== null &&
    completedAction !== null &&
    !completedAction.succeeded
    ? completedAction.action
    : null
  const failedSettingsSection = settingsSectionForAction(failedAction)
  const settingsActionError = settingsOpen &&
    failedSettingsSection === settingsSection
    ? actionError
    : null
  const failedFromSettings = failedAction !== null &&
    settingsActionRef.current === failedAction
  const timelineActionError = !settingsOpen &&
    !failedFromSettings &&
    isConversationAction(failedAction)
    ? actionError
    : null
  const headerActionError = !settingsOpen &&
    actionError !== null &&
    timelineActionError === null
    ? actionError
    : null
  const promptInDisplayedSession = async (
    message: string,
    attachments?: KernelPromptAttachment[]
  ): Promise<void> => {
    if (viewingNewSession) await onWaitForSessionStart()
    else if (viewedSessionKey !== null) await onActivateSession(viewedSessionKey)
    await onPrompt(message, attachments)
  }
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
    setProjectHoverCard({
      projectKey,
      left: Math.max(12, Math.min(bounds.right + 12, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(bounds.top - 8, window.innerHeight - estimatedHeight - 12))
    })
  }
  const togglePinnedProject = (projectKey: string): void => {
    setPinnedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) next.delete(projectKey)
      else next.add(projectKey)
      window.localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify([...next]))
      return next
    })
  }

  return (
    <main className={`app-shell${sidebarCollapsed ? ' left-sidebar-collapsed' : ''}${settingsOpen ? ' settings-open' : ''}`}>
      <aside className="left-sidebar" aria-label={settingsOpen ? '设置导航' : '项目与对话'}>
        <div className={`sidebar-content${settingsOpen ? ' settings-sidebar-content' : ''}`}>
          {settingsOpen ? (
            <>
              <button
                className="settings-back"
                type="button"
                onClick={() => {
                  restoreSettingsFocusRef.current = true
                  setSettingsOpen(false)
                }}
              >
                <span aria-hidden="true">←</span>
                <span>返回</span>
              </button>
              <nav className="settings-nav" aria-label="设置分类">
                <button
                  type="button"
                  className={settingsSection === 'general' ? 'selected' : ''}
                  aria-current={settingsSection === 'general' ? 'page' : undefined}
                  onClick={() => setSettingsSection('general')}
                >
                  <Icon name="settings" />
                  <span>常规</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'models' ? 'selected' : ''}
                  aria-current={settingsSection === 'models' ? 'page' : undefined}
                  onClick={() => setSettingsSection('models')}
                >
                  <Icon name="model" />
                  <span>模型</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'appearance' ? 'selected' : ''}
                  aria-current={settingsSection === 'appearance' ? 'page' : undefined}
                  onClick={() => setSettingsSection('appearance')}
                >
                  <Icon name="appearance" />
                  <span>外观</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'packages' ? 'selected' : ''}
                  aria-current={settingsSection === 'packages' ? 'page' : undefined}
                  onClick={() => setSettingsSection('packages')}
                >
                  <Icon name="packages" />
                  <span>Package</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'extensions' ? 'selected' : ''}
                  aria-current={settingsSection === 'extensions' ? 'page' : undefined}
                  onClick={() => setSettingsSection('extensions')}
                >
                  <Icon name="extensions" />
                  <span>拓展</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'skills' ? 'selected' : ''}
                  aria-current={settingsSection === 'skills' ? 'page' : undefined}
                  onClick={() => setSettingsSection('skills')}
                >
                  <Icon name="skills" />
                  <span>技能</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'preferences' ? 'selected' : ''}
                  aria-current={settingsSection === 'preferences' ? 'page' : undefined}
                  onClick={() => setSettingsSection('preferences')}
                >
                  <Icon name="preferences" />
                  <span>偏好</span>
                </button>
              </nav>
            </>
          ) : (
          <section
            className="sidebar-section project-list-section"
            aria-label="项目"
            aria-busy={contextActionStatus !== null}
          >
            {projects.length === 0 ? (
              <p className="empty-project-state muted" role="status">
                暂无项目。请使用侧边栏底部的“添加项目”。
              </p>
            ) : (
              displayedProjects.map((project) => {
                const selected = project.path === activeProjectKey
                const expanded = selected && project.path === expandedProjectKey
                const projectLabel = basename(project.path) ?? project.path
                const busySessionCount = project.busySessionCount ?? (selected
                  ? sessions.filter((summary) => {
                      const status = summary.key === activeSessionKey
                        ? runtime.status
                        : summary.runtimeStatus
                      return status === 'starting' || status === 'running' || status === 'stopping'
                    }).length
                  : 0)
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
                      draggable={
                        !busy && projects.length > 1 && dragArmedProjectKey === project.path
                      }
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
                          displayedProjects.map(({ path }) => path),
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
                        aria-expanded={selected ? expanded : undefined}
                        disabled={!selected && !canChangeProjectOrSession}
                        onPointerDown={(event) => {
                          if (event.button === 0 && !busy && projects.length > 1) {
                            setDragArmedProjectKey(project.path)
                          }
                        }}
                        onClick={() => {
                          if (selected) {
                            setExpandedProjectKey(expanded ? null : project.path)
                            return
                          }
                          if (!canChangeProjectOrSession) return
                          void onActivateProject(project.path)
                            .then(() => setExpandedProjectKey(project.path))
                            .catch(() => undefined)
                        }}
                      >
                        <span className="project-icon" aria-hidden="true">
                          <Icon name={expanded ? 'folder-open' : 'folder'} />
                        </span>
                        <span className="project-name">{projectLabel}</span>
                        {busySessionCount > 0 ? (
                          <span
                            className="project-activity-summary"
                            role="status"
                            aria-label={`有 ${busySessionCount} 个对话进行中`}
                            title={`有 ${busySessionCount} 个对话进行中`}
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
                      {selected ? (
                        <IconButton
                          className="project-new-chat"
                          icon="plus"
                          label="在此项目中启动对话"
                          aria-busy={pendingAction === 'start-session' ? true : undefined}
                          disabled={!canStartSession}
                          onClick={() => void onStartSession().catch(() => undefined)}
                        />
                      ) : null}
                    </div>

                    {expanded ? (
                      <div className="session-list">
                        {sessions.length === 0 ? (
                          <p className="empty-session-state muted">暂无对话。</p>
                        ) : sessions.map((summary) => {
                          const selected = summary.key === displayedSessionKey
                          const runtimeActive = summary.key === activeSessionKey
                          const previewSelected = viewedSessionKey === summary.key
                          const canPreview = !busy && (
                            !selected ||
                            (previewSelected && sessionPreview === null && !sessionPreviewPending)
                          )
                          const sessionRuntimeStatus = runtimeActive
                            ? runtime.status
                            : summary.runtimeStatus
                          const lifecycleLabel = sessionLifecycleLabel(sessionRuntimeStatus)
                          const unread = unreadSessionKeys.has(summary.key)
                          const activityLabel = formatActivityAge(summary.lastActivityAt, activityClock)
                          return (
                            <div
                              className={`session-row${selected ? ' selected' : ''}${draggedSessionKey === summary.key ? ' dragging' : ''}${dragOverSessionKey === summary.key ? ' drag-over' : ''}`}
                              key={summary.key}
                              draggable={
                                !busy && sessions.length > 1 && dragArmedSessionKey === summary.key
                              }
                              onDragStart={(event) => {
                                event.stopPropagation()
                                event.dataTransfer.effectAllowed = 'move'
                                setDraggedSessionKey(summary.key)
                              }}
                              onDragOver={(event) => {
                                if (draggedSessionKey === null || draggedSessionKey === summary.key) return
                                event.preventDefault()
                                event.stopPropagation()
                                event.dataTransfer.dropEffect = 'move'
                                setDragOverSessionKey(summary.key)
                              }}
                              onDrop={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                if (draggedSessionKey === null || draggedSessionKey === summary.key) return
                                void onReorderSessions(
                                  moveKey(sessions.map(({ key }) => key), draggedSessionKey, summary.key)
                                ).catch(() => undefined)
                              }}
                              onDragEnd={(event) => {
                                event.stopPropagation()
                                setDragArmedSessionKey(null)
                                setDraggedSessionKey(null)
                                setDragOverSessionKey(null)
                              }}
                            >
                              <button
                                className="session-item"
                                type="button"
                                title={summary.key}
                                aria-current={selected ? 'true' : undefined}
                                aria-busy={previewSelected && sessionPreviewPending ? true : undefined}
                                disabled={busy}
                                onPointerDown={(event) => {
                                  if (event.button === 0 && !busy && sessions.length > 1) {
                                    setDragArmedSessionKey(summary.key)
                                  }
                                }}
                                onClick={() => {
                                  if (!canPreview) return
                                  if (runtimeActive && !previewSelected) {
                                    onClearSessionPreview()
                                  } else if (summary.runtimeStatus !== 'stopped') {
                                    void onActivateSession(summary.key).catch(() => undefined)
                                  } else {
                                    void onPreviewSession(summary.key).catch(() => undefined)
                                  }
                                }}
                              >
                                <span className="session-title">{sessionTitle(summary)}</span>
                              </button>
                              <div className="session-action-slot">
                                {lifecycleLabel !== null ? (
                                  <span
                                    className={`session-lifecycle-indicator ${sessionRuntimeStatus}`}
                                    role="status"
                                    aria-label={lifecycleLabel}
                                    title={lifecycleLabel}
                                  >
                                    <span className="session-spinner-visual" aria-hidden="true" />
                                  </span>
                                ) : unread ? (
                                  <span
                                    className="session-unread-indicator"
                                    role="status"
                                    aria-label="有未读更新"
                                    title="有未读更新"
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
                                    void onArchiveSession(summary.key).catch(() => undefined)
                                  }}
                                />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </article>
                )
              })
            )}
          </section>
          )}
        </div>

        {settingsOpen ? null : (
          <footer className="sidebar-footer">
            <IconButton
              className="sidebar-collapse-toggle"
              icon="left-sidebar-close"
              label="收起侧边栏"
              onClick={() => setSidebarCollapsed(true)}
            />
            <IconButton
              className="add-project-entry"
              icon="plus"
              label="添加项目"
              aria-busy={pendingAction === 'add-project' ? true : undefined}
              disabled={!canChangeProjectOrSession}
              onClick={() => void onAddProject().catch(() => undefined)}
            />
            <IconButton
              ref={settingsButtonRef}
              className="sidebar-settings-toggle"
              icon="settings"
              label="设置"
              aria-pressed={false}
              onClick={() => setSettingsOpen(true)}
            />
          </footer>
        )}
      </aside>

      <section className="main-chat" aria-label={`${projectName} 对话工作区`}>
        {sidebarCollapsed ? (
          <div className="left-sidebar-bottom-triggers">
            <IconButton
              className="left-sidebar-trigger"
              icon="left-sidebar-open"
              label="展开侧边栏"
              onClick={() => setSidebarCollapsed(false)}
            />
          </div>
        ) : null}

        {settingsOpen ? (
          <SettingsPanel
            state={state}
            busy={busy}
            section={settingsSection}
            pendingAction={pendingAction}
            extensionActionError={extensionActionError}
            actionError={settingsActionError}
            systemFonts={systemFonts}
            systemFontsError={systemFontsError}
            onInstallExtension={onInstallExtension}
            onRemoveExtension={onRemoveExtension}
            onSearchPiDevExtensions={onSearchPiDevExtensions}
            onSearchPiDevPackages={onSearchPiDevPackages}
            onListPiPackages={onListPiPackages}
            onInstallPiDevPackage={onInstallPiDevPackage}
            onRemovePiPackage={onRemovePiPackage}
            onUpdatePiPackage={onUpdatePiPackage}
            onUpdatePiPackages={onUpdatePiPackages}
            onOpenExternal={onOpenExternal}
            onCreateSkill={async (prompt) => {
              await promptInDisplayedSession(prompt)
              setSettingsOpen(false)
            }}
            onListProviders={onListProviders}
            onSaveProvider={onSaveProvider}
            onRemoveProvider={onRemoveProvider}
            onTestProvider={onTestProvider}
            onSetModel={(provider, modelId) => {
              settingsActionRef.current = 'set-model'
              return onSetModel(provider, modelId)
            }}
            onSetSessionNaming={(settings) => {
              settingsActionRef.current = 'set-session-naming'
              return onSetSessionNaming(settings)
            }}
            onSetGeneral={(settings) => {
              settingsActionRef.current = 'set-general'
              return onSetGeneral(settings)
            }}
            onSetAppearance={(settings) => {
              settingsActionRef.current = 'set-appearance'
              return onSetAppearance(settings)
            }}
            toolDisplayDensity={toolDisplayDensity}
            onSetToolDisplayDensity={(density) => {
              setToolDisplayDensity(density)
              window.localStorage.setItem(TOOL_DISPLAY_DENSITY_STORAGE_KEY, density)
            }}
          />
        ) : (
          <>
        <header className="workbench-session-header">
          <strong className="workbench-session-title">
            {viewingNewSession
              ? '新对话'
              : activeSession === null ? '尚未选择对话' : sessionTitle(activeSession)}
          </strong>
          {contextActionStatus !== null ? (
            <span className="runtime-context-status" role="status" aria-live="polite">
              {contextActionStatus}
            </span>
          ) : null}
          {headerActionError === null ? null : (
            <span className="runtime-context-error" role="alert">{headerActionError}</span>
          )}
        </header>

        <Timeline
          key={`${activeProjectKey ?? 'no-project'}:${viewingNewSession ? 'new-session' : displayedSessionKey ?? 'no-session'}`}
          entries={displayedConversation.entries}
          activeRunStartIndex={displayedConversation.activeRunStartIndex}
          runtimeStatus={viewingInactiveSession
            ? activeSession?.runtimeStatus ?? 'ready'
            : runtime.status}
          toolDisplayDensity={toolDisplayDensity}
          warning={
            timelineActionError ??
            (runtime.status === 'crashed'
              ? runtime.lastError ?? 'Pi Runtime 意外退出，未提供错误详情。'
              : null)
          }
        />

        <Composer
          state={state}
          sessionPreview={sessionPreview}
          viewingInactiveSession={viewingInactiveSession}
          viewingNewSession={viewingNewSession}
          newSessionPrepared={newSessionPrepared}
          busy={busy}
          pendingAction={pendingAction}
          completedAction={completedAction}
          onSelectPromptAttachments={onSelectPromptAttachments}
          onStartSession={onStartSession}
          onActivateSession={onActivateSession}
          onPrompt={async (message, attachments) => {
            await promptInDisplayedSession(message, attachments)
          }}
          onSteer={onSteer}
          onFollowUp={onFollowUp}
          onInvokeCommand={async (commandId, argument) => {
            if (viewingNewSession) await onWaitForSessionStart()
            else if (viewedSessionKey !== null) await onActivateSession(viewedSessionKey)
            await onInvokeCommand(commandId, argument)
          }}
          onAbort={onAbort}
          onSetModel={(provider, modelId) => {
            settingsActionRef.current = null
            return onSetModel(provider, modelId)
          }}
          onSetThinkingLevel={(level) => {
            settingsActionRef.current = null
            return onSetThinkingLevel(level)
          }}
        />
          </>
        )}
      </section>

      {hoveredProject === null || projectHoverCard === null ? null : createPortal(
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
                <Icon name="folder-open" />
              </span>
              <strong>{basename(hoveredProject.path) ?? hoveredProject.path}</strong>
              <button
                className={`project-pin-action${pinnedProjectKeys.has(hoveredProject.path) ? ' pinned' : ''}`}
                type="button"
                aria-label={pinnedProjectKeys.has(hoveredProject.path) ? '取消置顶项目' : '置顶项目'}
                aria-pressed={pinnedProjectKeys.has(hoveredProject.path)}
                title={pinnedProjectKeys.has(hoveredProject.path) ? '取消置顶' : '置顶项目'}
                onClick={() => togglePinnedProject(hoveredProject.path)}
              >
                <Icon name={pinnedProjectKeys.has(hoveredProject.path) ? 'pin-filled' : 'pin'} />
              </button>
            </div>
            <div className="project-hover-card-stats">
              <div className="project-hover-stat">
                <span className="project-hover-stat-icon" aria-hidden="true"><Icon name="messages" /></span>
                <span>Session</span>
                <strong>{hoveredProject.path === activeProjectKey
                  ? sessions.length
                  : sessionCountsByProjectRef.current.get(hoveredProject.path) ?? hoveredProject.sessionCount ?? 0}</strong>
              </div>
              <div className="project-hover-stat">
                <span className="project-hover-stat-icon" aria-hidden="true"><Icon name="unread" /></span>
                <span>未读</span>
                <strong>{hoveredProject.unreadCount ?? 0}</strong>
              </div>
            </div>
          </div>
          <div className="project-hover-card-path">
            <span>项目路径</span>
            <code title={hoveredProject.path}>{hoveredProject.path}</code>
          </div>
        </aside>,
        document.body
      )}
    </main>
  )
}

function basename(path: string | null): string | null {
  if (path === null) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function sessionTitle(session: KernelState['sessions'][number]): string {
  if (session.name !== null && session.name.trim().length > 0) return session.name
  return `对话 ${session.id.slice(0, 8)}`
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

function runtimeContextActionStatus(action: string | null): string | null {
  if (action === 'add-project') return '正在添加项目…'
  if (action === 'activate-project') return '正在切换项目…'
  if (action === 'activate-session') return '正在切换对话…'
  if (action === 'preview-session') return '正在读取对话…'
  if (action === 'archive-session') return '正在归档对话…'
  if (action === 'reorder-projects' || action === 'reorder-sessions') return '正在保存排序…'
  return null
}

function isConversationAction(action: string | null): boolean {
  return action === 'prompt' ||
    action === 'steer' ||
    action === 'follow-up' ||
    action === 'invoke-command' ||
    action === 'abort' ||
    action === 'set-model' ||
    action === 'set-thinking-level'
}

function settingsSectionForAction(action: string | null): SettingsSection | null {
  if (action === 'set-general') return 'general'
  if (action === 'set-appearance') return 'appearance'
  if (action === 'set-model') return 'models'
  if (action === 'set-session-naming') return 'preferences'
  return null
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
