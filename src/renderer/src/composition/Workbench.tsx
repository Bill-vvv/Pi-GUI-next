import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

import type {
  AppearanceSettings,
  GeneralSettings,
  KernelExtensionSelectionKind,
  KernelForkCandidate,
  KernelInstalledPackage,
  KernelModelPricingFetchResult,
  KernelPiDevCatalog,
  KernelProjectTrustChoice,
  KernelPromptAttachment,
  KernelProjectPathSearchResult,
  KernelProviderAuthEvent,
  KernelProviderAuthType,
  KernelProviderConfig,
  KernelProviderCredential,
  KernelProviderInput,
  KernelProviderTestResult,
  KernelSessionPreview,
  KernelState,
  SessionNamingSettings,
  SubagentSettings,
  ShortcutSettings,
  ThinkingLevel
} from '../../../shared/kernel-contract'
import {
  DEFAULT_SHORTCUT_SETTINGS,
  SHORTCUT_ACTION_IDS,
  shortcutBindingFromKeyboardInput,
  type ShortcutActionId
} from '../../../shared/shortcut-settings'
import { Icon } from '../components/Icon'
import { IconButton } from '../components/IconButton'
import {
  Composer,
  type ComposerControlRequest,
  type ComposerDraftRequest
} from '../features/composer/Composer'
import {
  basename,
  ProjectNavigator,
  sessionTitle
} from '../features/project/ProjectNavigator'
import { SessionForkDialog } from '../features/session/SessionForkDialog'
import { SettingsPanel, type SettingsSection } from '../features/settings/SettingsPanel'
import { Timeline } from '../features/chat/Timeline'
import { ProjectTrustDialog } from '../features/trust/ProjectTrustDialog'
import {
  DEFAULT_TOOL_DISPLAY_DENSITY,
  isToolDisplayDensity,
  type ToolDisplayDensity
} from '../tool-display-density'
import '../styles/chat.css'

const TOOL_DISPLAY_DENSITY_STORAGE_KEY = 'pi-workbench.tool-display-density'
const PINNED_PROJECTS_STORAGE_KEY = 'pi-workbench.pinned-projects'
const EDITABLE_TARGET_SHORTCUTS = new Set(
  Object.values(DEFAULT_SHORTCUT_SETTINGS).filter((binding): binding is string => binding !== null)
)

type WorkbenchProps = {
  state: KernelState
  sessionPreview: KernelSessionPreview | null
  archivedSessionPreview: KernelSessionPreview | null
  composerDraftRequest: ComposerDraftRequest | null
  viewedSessionKey: string | null
  viewingNewSession: boolean
  newSessionPrepared: boolean
  sessionPreviewPending: boolean
  pendingAction: string | null
  completedAction: { action: string; succeeded: boolean } | null
  actionError: string | null
  systemFonts: string[] | null
  systemFontsError: string | null
  forkDialogOpen: boolean
  forkCandidates: KernelForkCandidate[]
  forkCandidatesLoading: boolean
  forkError: string | null
  forkSubmitting: boolean
  onAddProject: () => Promise<void>
  onActivateProject: (projectKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onReloadSession: () => Promise<void>
  onWaitForSessionStart: () => Promise<void>
  onResolveProjectTrust: (
    requestId: string,
    choice: KernelProjectTrustChoice
  ) => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onEnsureSessionRuntime: (
    sessionKey: string,
    mode?: 'immediate' | 'settled'
  ) => Promise<void>
  onPreviewSession: (sessionKey: string) => Promise<void>
  onClearSessionPreview: () => void
  onClearArchivedSessionPreview: () => void
  onOpenForkDialog: () => void
  onCloseForkDialog: () => void
  onRetryForkCandidates: () => void
  onForkSession: (entryId: string) => Promise<void>
  onExportSession: () => Promise<void>
  onCopyLastAnswer: () => Promise<void>
  onArchiveSession: (sessionKey: string) => Promise<void>
  onReorderProjects: (projectKeys: string[]) => Promise<void>
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
  onFetchModelPricing: (
    providerId: string,
    modelIds: string[]
  ) => Promise<KernelModelPricingFetchResult>
  onListProviderCredentials: () => Promise<KernelProviderCredential[]>
  onLoginProvider: (
    providerId: string,
    authType: KernelProviderAuthType
  ) => Promise<KernelProviderCredential[]>
  onSubmitProviderAuthPrompt: (
    operationId: string,
    promptId: string,
    value: string
  ) => Promise<void>
  onCancelProviderLogin: (operationId: string) => Promise<void>
  onLogoutProvider: (providerId: string) => Promise<KernelProviderCredential[]>
  onSubscribeProviderAuth: (
    listener: (event: KernelProviderAuthEvent) => void
  ) => () => void
  onSelectPromptAttachments: () => Promise<KernelPromptAttachment[]>
  onSearchProjectPaths: (query: string) => Promise<KernelProjectPathSearchResult>
  onPrompt: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onSteer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onFollowUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettings) => Promise<void>
  onSetSubagentEnabled: (enabled: boolean) => Promise<void>
  onSetSubagent: (settings: SubagentSettings) => Promise<void>
  onSetAppearance: (settings: AppearanceSettings) => Promise<void>
  onSetShortcuts: (settings: ShortcutSettings) => Promise<void>
}

export function Workbench({
  state,
  sessionPreview,
  archivedSessionPreview,
  composerDraftRequest,
  viewedSessionKey,
  viewingNewSession,
  newSessionPrepared,
  sessionPreviewPending,
  pendingAction,
  completedAction,
  actionError,
  systemFonts,
  systemFontsError,
  forkDialogOpen,
  forkCandidates,
  forkCandidatesLoading,
  forkError,
  forkSubmitting,
  onAddProject,
  onActivateProject,
  onStartSession,
  onReloadSession,
  onWaitForSessionStart,
  onResolveProjectTrust,
  onActivateSession,
  onEnsureSessionRuntime,
  onPreviewSession,
  onClearSessionPreview,
  onClearArchivedSessionPreview,
  onOpenForkDialog,
  onCloseForkDialog,
  onRetryForkCandidates,
  onForkSession,
  onExportSession,
  onCopyLastAnswer,
  onArchiveSession,
  onReorderProjects,
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
  onFetchModelPricing,
  onListProviderCredentials,
  onLoginProvider,
  onSubmitProviderAuthPrompt,
  onCancelProviderLogin,
  onLogoutProvider,
  onSubscribeProviderAuth,
  onSelectPromptAttachments,
  onSearchProjectPaths,
  onPrompt,
  onSteer,
  onFollowUp,
  onInvokeCommand,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
  onSetSessionNaming,
  onSetGeneral,
  onSetSubagentEnabled,
  onSetSubagent,
  onSetAppearance,
  onSetShortcuts
}: WorkbenchProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia('(max-width: 700px)').matches
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [shortcutRecording, setShortcutRecording] = useState(false)
  const [composerControlRequest, setComposerControlRequest] =
    useState<ComposerControlRequest | null>(null)
  const [toolDisplayDensity, setToolDisplayDensity] = useState<ToolDisplayDensity>(() => {
    const stored = window.localStorage.getItem(TOOL_DISPLAY_DENSITY_STORAGE_KEY)
    return isToolDisplayDensity(stored) ? stored : DEFAULT_TOOL_DISPLAY_DENSITY
  })
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
  const {
    projects,
    activeProjectKey,
    sessions,
    activeSessionKey,
    runtime,
    conversation
  } = state
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const restoreSettingsFocusRef = useRef(false)
  const settingsActionRef = useRef<string | null>(null)
  const composerControlRevisionRef = useRef(0)
  useEffect(() => {
    if (settingsOpen || !restoreSettingsFocusRef.current) return
    restoreSettingsFocusRef.current = false
    settingsButtonRef.current?.focus()
  }, [settingsOpen])
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (
        !document.hasFocus() ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        shortcutRecording ||
        hasVisibleShortcutBlockingSurface()
      ) return
      if (settingsOpen && event.key === 'Escape') {
        restoreSettingsFocusRef.current = true
        setSettingsOpen(false)
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const binding = shortcutBindingFromKeyboardInput(event)
      if (binding === null) return
      if (hasEditableShortcutTarget(event) && !EDITABLE_TARGET_SHORTCUTS.has(binding)) return
      const actionId = SHORTCUT_ACTION_IDS.find(
        (candidate) => state.shortcuts[candidate] === binding
      )
      if (actionId === undefined || !dispatchShortcutAction(actionId)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })
  const doubleClickBorderMaximize = state.general.doubleClickBorderMaximize !== false
  const handleWindowEdgeDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!doubleClickBorderMaximize || event.defaultPrevented || event.button !== 0) return
    if (typeof window.piGui.toggleMaximize !== 'function') return
    event.preventDefault()
    event.stopPropagation()
    void window.piGui.toggleMaximize().catch(() => undefined)
  }
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
  const displayedSessionKey = viewingNewSession
    ? null
    : viewedSessionKey ?? activeSessionKey
  const viewingInactiveSession =
    viewedSessionKey !== null && viewedSessionKey !== activeSessionKey
  const activeSession = displayedSessionKey === null
    ? null
    : sessions.find((summary) => summary.key === displayedSessionKey) ?? null
  const viewingArchivedSession = archivedSessionPreview !== null
  const projectName = basename(activeProject?.path ?? null) ?? '未选择项目'
  const busy = pendingAction !== null
  const canChangeProjectOrSession = !busy
  const canStartSession =
    canChangeProjectOrSession &&
    activeProject !== null
  const displayedConversation = archivedSessionPreview?.conversation ?? (
    viewingNewSession && !newSessionPrepared
    ? { entries: [], activeRunStartIndex: null }
    : sessionPreview?.conversation ?? (
        viewingInactiveSession ? { entries: [], activeRunStartIndex: null } : conversation
      )
  )
  const canForkSession =
    !viewingArchivedSession &&
    sessionPreview === null &&
    !viewingInactiveSession &&
    !viewingNewSession &&
    activeSessionKey !== null &&
    runtime.status === 'ready' &&
    state.session.settled
  const canExportSession =
    !viewingArchivedSession &&
    sessionPreview === null &&
    !viewingInactiveSession &&
    !viewingNewSession &&
    activeSessionKey !== null &&
    runtime.status !== 'starting' &&
    runtime.status !== 'running' &&
    runtime.status !== 'stopping' &&
    state.session.settled
  const canCopyLastAnswer =
    canForkSession &&
    displayedConversation.entries.some((entry) =>
      entry.kind === 'message' &&
      entry.role === 'assistant' &&
      !entry.streaming &&
      (entry.phase === 'final_answer' || entry.phase == null) &&
      entry.text.trim().length > 0
    )
  const conversationActionStatus =
    pendingAction === 'export-session'
      ? '正在导出 HTML…'
      : pendingAction === 'copy-last-answer'
        ? '正在复制回答…'
        : pendingAction === null &&
          completedAction?.action === 'copy-last-answer' &&
          completedAction.succeeded
          ? '已复制最后一条回答'
          : null
  const contextActionStatus = sessionPreviewPending
    ? '正在读取对话…'
    : runtimeContextActionStatus(pendingAction)
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
  const conversationActionError = !settingsOpen &&
    actionError !== null &&
    (failedAction === 'copy-last-answer' || failedAction === 'export-session')
    ? actionError
    : null
  const headerActionError = !settingsOpen &&
    actionError !== null &&
    timelineActionError === null &&
    conversationActionError === null
    ? actionError
    : null
  const promptInDisplayedSession = async (
    message: string,
    attachments?: KernelPromptAttachment[]
  ): Promise<void> => {
    if (viewingArchivedSession) throw new Error('Archived session previews are read-only.')
    if (viewingNewSession) await onWaitForSessionStart()
    else if (viewedSessionKey !== null) await onActivateSession(viewedSessionKey)
    await onPrompt(message, attachments)
  }
  const openSession = (
    sessionKey: string,
    runtimeStatus: KernelState['sessions'][number]['runtimeStatus']
  ): void => {
    const isActive = sessionKey === activeSessionKey
    const isLive =
      runtimeStatus === 'ready' ||
      runtimeStatus === 'running' ||
      runtimeStatus === 'starting' ||
      runtimeStatus === 'stopping'

    // Already showing this live session: just clear any stale preview target.
    if (isActive && isLive && viewedSessionKey === null) return
    if (isActive && isLive) {
      onClearSessionPreview()
      return
    }

    // Active but stopped/crashed: resume immediately in the background.
    if (isActive && !isLive) {
      void onEnsureSessionRuntime(sessionKey, 'immediate').catch(() => undefined)
      return
    }

    // Stopped/crashed historical targets: switch the view this frame, then dwell
    // briefly so rapid browsing only starts the last selected Runtime.
    if (!isLive) {
      void onPreviewSession(sessionKey).catch(() => undefined)
      void onEnsureSessionRuntime(sessionKey, 'settled').catch(() => undefined)
      return
    }

    // Already-managed live Runtime: switch context immediately, no dwell.
    void onEnsureSessionRuntime(sessionKey, 'immediate').catch(() => undefined)
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
  const requestComposerControl = (action: ComposerControlRequest['action']): void => {
    composerControlRevisionRef.current += 1
    setComposerControlRequest({ id: composerControlRevisionRef.current, action })
  }
  const dispatchShortcutAction = (actionId: ShortcutActionId): boolean => {
    if (actionId === 'open-settings') {
      if (viewingArchivedSession) onClearArchivedSessionPreview()
      setSidebarCollapsed(false)
      setSettingsOpen(true)
      return true
    }
    if (actionId === 'new-session') {
      if (!canStartSession) return false
      setSettingsOpen(false)
      void onStartSession().catch(() => undefined)
      return true
    }
    if (actionId === 'focus-composer') {
      const displayedStatus = viewingInactiveSession
        ? activeSession?.runtimeStatus ?? 'stopped'
        : runtime.status
      if (
        busy ||
        viewingArchivedSession ||
        activeProject === null ||
        (displayedStatus !== 'ready' && displayedStatus !== 'running')
      ) return false
      setSettingsOpen(false)
      requestComposerControl('focus')
      return true
    }
    if (actionId === 'open-model-selector') {
      if (
        busy ||
        viewingArchivedSession ||
        viewingInactiveSession ||
        (viewingNewSession && !newSessionPrepared) ||
        (!viewingNewSession && activeSessionKey === null) ||
        runtime.status !== 'ready'
      ) return false
      setSettingsOpen(false)
      requestComposerControl('open-model-picker')
      return true
    }
    if (actionId === 'reload-session') {
      if (
        busy ||
        viewingArchivedSession ||
        viewingInactiveSession ||
        viewingNewSession ||
        activeSessionKey === null ||
        runtime.status !== 'ready' ||
        !state.session.settled
      ) return false
      void onReloadSession().catch(() => undefined)
      return true
    }
    if (actionId === 'archive-session') {
      if (
        busy ||
        viewingArchivedSession ||
        viewingInactiveSession ||
        viewingNewSession ||
        activeSessionKey === null
      ) return false
      void onArchiveSession(activeSessionKey).catch(() => undefined)
      return true
    }
    if (actionId === 'copy-last-answer') {
      if (
        busy ||
        viewingArchivedSession ||
        viewingInactiveSession ||
        viewingNewSession ||
        activeSessionKey === null ||
        runtime.status !== 'ready' ||
        !state.session.settled
      ) return false
      void onCopyLastAnswer().catch(() => undefined)
      return true
    }
    if (actionId === 'previous-project' || actionId === 'next-project') {
      if (busy || activeProjectKey === null) return false
      const currentIndex = displayedProjects.findIndex(({ path }) => path === activeProjectKey)
      const targetIndex = currentIndex + (actionId === 'previous-project' ? -1 : 1)
      const target = displayedProjects[targetIndex]
      if (target === undefined) return false
      void onActivateProject(target.path).catch(() => undefined)
      return true
    }
    if (busy || displayedSessionKey === null) return false
    const currentIndex = sessions.findIndex(({ key }) => key === displayedSessionKey)
    const targetIndex = currentIndex + (actionId === 'previous-session' ? -1 : 1)
    const target = sessions[targetIndex]
    if (target === undefined) return false
    openSession(target.key, target.runtimeStatus)
    return true
  }
  return (
    <main className={`app-shell${sidebarCollapsed ? ' left-sidebar-collapsed' : ''}${settingsOpen ? ' settings-open' : ''}`}>
      {doubleClickBorderMaximize ? (
        <div className="window-edge-hit-layer" aria-hidden="true">
          <div className="window-edge-hit top" onDoubleClick={handleWindowEdgeDoubleClick} />
          <div className="window-edge-hit right" onDoubleClick={handleWindowEdgeDoubleClick} />
          <div className="window-edge-hit bottom" onDoubleClick={handleWindowEdgeDoubleClick} />
          <div className="window-edge-hit left" onDoubleClick={handleWindowEdgeDoubleClick} />
        </div>
      ) : null}
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
                  className={settingsSection === 'credentials' ? 'selected' : ''}
                  aria-current={settingsSection === 'credentials' ? 'page' : undefined}
                  onClick={() => setSettingsSection('credentials')}
                >
                  <Icon name="preferences" />
                  <span>凭证</span>
                </button>
                <button
                  type="button"
                  className={settingsSection === 'shortcuts' ? 'selected' : ''}
                  aria-current={settingsSection === 'shortcuts' ? 'page' : undefined}
                  onClick={() => setSettingsSection('shortcuts')}
                >
                  <Icon name="preferences" />
                  <span>快捷键</span>
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
                  className={settingsSection === 'subagent' ? 'selected' : ''}
                  aria-current={settingsSection === 'subagent' ? 'page' : undefined}
                  onClick={() => setSettingsSection('subagent')}
                >
                  <Icon name="subagents" />
                  <span>Subagent</span>
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
          ) : null}
          <ProjectNavigator
            hidden={settingsOpen}
            projects={displayedProjects}
            activeProjectKey={activeProjectKey}
            sessions={sessions}
            displayedSessionKey={displayedSessionKey}
            viewedSessionKey={viewedSessionKey}
            viewingArchivedSession={viewingArchivedSession}
            sidebarCollapsed={sidebarCollapsed}
            busy={busy}
            canChangeProjectOrSession={canChangeProjectOrSession}
            sessionPreviewPending={sessionPreviewPending}
            pendingAction={pendingAction}
            contextActionStatus={contextActionStatus}
            pinnedProjectKeys={pinnedProjectKeys}
            onTogglePinnedProject={togglePinnedProject}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            onClearArchivedSessionPreview={onClearArchivedSessionPreview}
            onActivateProject={onActivateProject}
            onStartSession={onStartSession}
            onOpenSession={openSession}
            onArchiveSession={onArchiveSession}
            onReorderProjects={onReorderProjects}
          />
        </div>

        {settingsOpen ? null : (
          <footer className="sidebar-footer">
            <IconButton
              className="sidebar-collapse-toggle"
              icon="left-sidebar-close"
              iconSize="lg"
              label="收起侧边栏"
              onClick={() => setSidebarCollapsed(true)}
            />
            <IconButton
              className="add-project-entry"
              icon="plus"
              iconSize="lg"
              label="添加项目"
              aria-busy={pendingAction === 'add-project' ? true : undefined}
              disabled={!canChangeProjectOrSession}
              onClick={() => void onAddProject().catch(() => undefined)}
            />
            <IconButton
              ref={settingsButtonRef}
              className="sidebar-settings-toggle"
              icon="settings"
              iconSize="lg"
              label="设置"
              aria-pressed={false}
              onClick={() => {
                if (viewingArchivedSession) onClearArchivedSessionPreview()
                setSidebarCollapsed(false)
                setSettingsOpen(true)
              }}
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
            onFetchModelPricing={onFetchModelPricing}
            onListProviderCredentials={onListProviderCredentials}
            onLoginProvider={onLoginProvider}
            onSubmitProviderAuthPrompt={onSubmitProviderAuthPrompt}
            onCancelProviderLogin={onCancelProviderLogin}
            onLogoutProvider={onLogoutProvider}
            onSubscribeProviderAuth={onSubscribeProviderAuth}
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
            onSetSubagentEnabled={(enabled) => {
              settingsActionRef.current = 'set-subagent-enabled'
              return onSetSubagentEnabled(enabled)
            }}
            onSetSubagent={(settings) => {
              settingsActionRef.current = 'set-subagent'
              return onSetSubagent(settings)
            }}
            onSetAppearance={(settings) => {
              settingsActionRef.current = 'set-appearance'
              return onSetAppearance(settings)
            }}
            onSetShortcuts={onSetShortcuts}
            onShortcutRecordingChange={setShortcutRecording}
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
            {archivedSessionPreview !== null
              ? archivedSessionPreview.sessionName ?? `对话 ${archivedSessionPreview.sessionId.slice(0, 8)}`
              : viewingNewSession
              ? '新对话'
              : activeSession === null ? '尚未选择对话' : sessionTitle(activeSession)}
          </strong>
          {archivedSessionPreview !== null ? (
            <span className="archived-preview-status" role="status">
              已归档 · 临时只读
              <button
                className="archived-preview-exit"
                type="button"
                onClick={onClearArchivedSessionPreview}
              >
                退出预览
              </button>
            </span>
          ) : sessionPreview !== null && viewingInactiveSession ? (
            <span className="runtime-context-status">历史预览</span>
          ) : null}
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
          key={`${activeProjectKey ?? 'no-project'}:${archivedSessionPreview !== null ? `archived:${archivedSessionPreview.sessionKey}` : viewingNewSession ? 'new-session' : displayedSessionKey ?? 'no-session'}`}
          entries={displayedConversation.entries}
          activeRunStartIndex={displayedConversation.activeRunStartIndex}
          runtimeStatus={viewingArchivedSession
            ? 'stopped'
            : viewingInactiveSession
            ? activeSession?.runtimeStatus ?? 'ready'
            : runtime.status}
          compactionActive={
            !viewingArchivedSession &&
            !viewingInactiveSession &&
            !viewingNewSession &&
            state.session.compaction !== null
          }
          showPromptNavigation={!sidebarCollapsed}
          toolDisplayDensity={toolDisplayDensity}
          canCopyLastAnswer={canCopyLastAnswer}
          canExportSession={canExportSession}
          canForkSession={canForkSession}
          conversationActionBusy={busy}
          conversationActionStatus={conversationActionStatus}
          conversationActionError={conversationActionError}
          onCopyLastAnswer={onCopyLastAnswer}
          onExportSession={onExportSession}
          onForkSession={onOpenForkDialog}
          warning={
            timelineActionError ??
            (!viewingArchivedSession && runtime.status === 'crashed'
              ? runtime.lastError ?? 'Pi Runtime 意外退出，未提供错误详情。'
              : null)
          }
        />

        {viewingArchivedSession ? null : <Composer
          state={state}
          sessionPreview={sessionPreview}
          draftRequest={composerDraftRequest}
          controlRequest={composerControlRequest}
          viewedSessionKey={viewedSessionKey}
          viewingInactiveSession={viewingInactiveSession}
          viewingNewSession={viewingNewSession}
          newSessionPrepared={newSessionPrepared}
          busy={busy}
          pendingAction={pendingAction}
          completedAction={completedAction}
          onSelectPromptAttachments={onSelectPromptAttachments}
          onSearchProjectPaths={onSearchProjectPaths}
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
        />}
          </>
        )}
      </section>

      {state.projectTrustRequest === null ? null : (
        <ProjectTrustDialog
          key={state.projectTrustRequest.id}
          request={state.projectTrustRequest}
          onResolve={onResolveProjectTrust}
        />
      )}
      {forkDialogOpen ? (
        <SessionForkDialog
          candidates={forkCandidates}
          loading={forkCandidatesLoading}
          error={forkError}
          submitting={forkSubmitting}
          onCancel={onCloseForkDialog}
          onRetry={onRetryForkCandidates}
          onSubmit={onForkSession}
        />
      ) : null}
    </main>
  )
}

function runtimeContextActionStatus(action: string | null): string | null {
  if (action === 'add-project') return '正在添加项目…'
  if (action === 'activate-project') return '正在切换项目…'
  if (action === 'activate-session') return '正在切换对话…'
  if (action === 'preview-session') return '正在读取对话…'
  if (action === 'archive-session') return '正在归档对话…'
  if (action === 'reorder-projects') return '正在保存排序…'
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
  if (action === 'set-subagent-enabled' || action === 'set-subagent') return 'subagent'
  if (action === 'set-session-naming') return 'preferences'
  return null
}

function hasVisibleShortcutBlockingSurface(): boolean {
  return [...document.querySelectorAll<HTMLElement>(
    '[aria-modal="true"], [role="menu"], [role="listbox"]'
  )].some((element) => {
    if (element.getAttribute('aria-hidden') === 'true' || element.getClientRects().length === 0) {
      return false
    }
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
}

function hasEditableShortcutTarget(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) =>
    target instanceof HTMLElement &&
    (
      target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT'
    )
  )
}
