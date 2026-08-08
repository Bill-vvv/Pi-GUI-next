import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'

import type {
  AppearanceSettings,
  GeneralSettings,
  KernelAskAnswer,
  KernelExtensionSelectionKind,
  KernelForkCandidate,
  KernelInstalledPackage,
  KernelModelPricingFetchResult,
  KernelNavigatorKind,
  KernelPiPackageInstallJob,
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
  KernelSubagentDefinition,
  KernelSubagentEditableScope,
  KernelSubagentDefinitionInput,
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
import {
  orderTaskItems,
  TaskNavigator
} from '../features/project/TaskNavigator'
import { SessionForkDialog } from '../features/session/SessionForkDialog'
import { SettingsPanel } from '../features/settings/SettingsPanel'
import { SettingsNavigation } from '../features/settings/SettingsNavigation'
import { useSettingsWorkspace } from '../features/settings/settings-workspace'
import { Timeline } from '../features/chat/Timeline'
import { SubagentTaskDetail } from '../features/chat/SubagentTaskDetail'
import {
  matchesSubagentTaskTrigger,
  reconcileSubagentTaskSelection,
  resolveSubagentTaskSelection,
  SUBAGENT_TASK_TRIGGER_SELECTOR,
  subagentTaskSelectionKey,
  workbenchConversationIdentity,
  type SubagentTaskSelection,
  type SubagentTaskTarget
} from '../features/chat/subagent-task-detail-model'
import { GitChangesPanel } from '../features/git/GitChangesPanel'
import { ProjectTrustDialog } from '../features/trust/ProjectTrustDialog'
import { RIGHT_SIDEBAR_ID, RightSidebar } from './RightSidebar'
import { reconcileRightSidebarActiveTab } from './right-sidebar-model'
import { timelineConversation } from './conversation-presentation'
import {
  DEFAULT_TOOL_DISPLAY_DENSITY,
  isToolDisplayDensity,
  type ToolDisplayDensity
} from '../tool-display-density'
import { currentTurnTodos } from '../todo-state'
import {
  isWorkbenchAction,
  runtimeContextActionStatus,
  type WorkbenchActionFailure,
  type WorkbenchActionOrigin,
  type WorkbenchCompletedAction,
  type WorkbenchOperation
} from '../workbench-actions'

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
  pendingAction: WorkbenchOperation | null
  completedAction: WorkbenchCompletedAction | null
  actionFailure: WorkbenchActionFailure | null
  operationNotifications: ReactNode
  systemFonts: string[] | null
  systemFontsError: string | null
  packageInstallJobs: KernelPiPackageInstallJob[]
  forkDialogOpen: boolean
  forkCandidates: KernelForkCandidate[]
  forkCandidatesLoading: boolean
  forkError: string | null
  forkSubmitting: boolean
  forkPreferredUserText: string | null
  onAddProject: () => Promise<void>
  onActivateProject: (projectKey: string) => Promise<void>
  onCreateTask: () => Promise<void>
  onActivateTask: (taskKey: string, sessionKey: string) => Promise<void>
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
  onSelectSession: (sessionKey: string) => Promise<void>
  onClearSessionPreview: () => void
  onClearArchivedSessionPreview: () => void
  onOpenForkDialog: (preferredUserText?: string) => void
  onCloseForkDialog: () => void
  onRetryForkCandidates: () => void
  onForkSession: (entryId: string) => Promise<void>
  onExportSession: () => Promise<void>
  onLoadEarlierConversation: () => Promise<void>
  onCopyAnswer: (text: string) => Promise<void>
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
  onSubmitAsk: (
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ) => Promise<void>
  onCancelAsk: (sessionKey: string, toolCallId: string) => Promise<void>
  onPrompt: (
    message: string,
    attachments?: KernelPromptAttachment[],
    expectedSessionKey?: string
  ) => Promise<void>
  onNavigateHistoryPrompt: (sessionKey: string, messageId: string) => Promise<void>
  onSteer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onFollowUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (
    provider: string,
    modelId: string,
    origin: WorkbenchActionOrigin
  ) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetOpenAiFastMode: (enabled: boolean) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettings) => Promise<void>
  onSetSubagentEnabled: (enabled: boolean) => Promise<void>
  onSetMagicContextEnabled: (enabled: boolean) => Promise<void>
  onListSubagentDefinitions: () => Promise<KernelSubagentDefinition[]>
  onSaveSubagentDefinition: (
    definition: KernelSubagentDefinitionInput
  ) => Promise<KernelSubagentDefinition[]>
  onSetSubagentDefinitionEnabled: (
    id: string,
    scope: KernelSubagentEditableScope,
    enabled: boolean
  ) => Promise<KernelSubagentDefinition[]>
  onRemoveSubagentDefinition: (id: string) => Promise<KernelSubagentDefinition[]>
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
  actionFailure,
  operationNotifications,
  systemFonts,
  systemFontsError,
  packageInstallJobs,
  forkDialogOpen,
  forkCandidates,
  forkCandidatesLoading,
  forkError,
  forkSubmitting,
  forkPreferredUserText,
  onAddProject,
  onActivateProject,
  onCreateTask,
  onActivateTask,
  onStartSession,
  onReloadSession,
  onWaitForSessionStart,
  onResolveProjectTrust,
  onActivateSession,
  onEnsureSessionRuntime,
  onSelectSession,
  onClearSessionPreview,
  onClearArchivedSessionPreview,
  onOpenForkDialog,
  onCloseForkDialog,
  onRetryForkCandidates,
  onForkSession,
  onExportSession,
  onLoadEarlierConversation,
  onCopyAnswer,
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
  onSubmitAsk,
  onCancelAsk,
  onPrompt,
  onNavigateHistoryPrompt,
  onSteer,
  onFollowUp,
  onInvokeCommand,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
  onSetOpenAiFastMode,
  onSetSessionNaming,
  onSetGeneral,
  onSetSubagentEnabled,
  onSetMagicContextEnabled,
  onListSubagentDefinitions,
  onSaveSubagentDefinition,
  onSetSubagentDefinitionEnabled,
  onRemoveSubagentDefinition,
  onSetSubagent,
  onSetAppearance,
  onSetShortcuts
}: WorkbenchProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.matchMedia('(max-width: 700px)').matches
  )
  const [projectNavigatorExpanded, setProjectNavigatorExpanded] = useState(true)
  const [taskNavigatorExpanded, setTaskNavigatorExpanded] = useState(true)
  const {
    settingsOpen,
    settingsSection,
    openSettings,
    requestSectionChange,
    requestCloseSettings,
    onDirtyChange,
    onActiveOperationChange
  } = useSettingsWorkspace()
  const [shortcutRecording, setShortcutRecording] = useState(false)
  useEffect(() => {
    const compactWorkbench = window.matchMedia('(max-width: 700px)')
    const syncCompactSidebar = (): void => {
      if (compactWorkbench.matches && !settingsOpen) setSidebarCollapsed(true)
    }
    syncCompactSidebar()
    compactWorkbench.addEventListener('change', syncCompactSidebar)
    return () => compactWorkbench.removeEventListener('change', syncCompactSidebar)
  }, [settingsOpen])
  const [composerControlRequest, setComposerControlRequest] =
    useState<ComposerControlRequest | null>(null)
  const [historyPromptEditing, setHistoryPromptEditing] = useState(false)
  const [subagentTaskSelection, setSubagentTaskSelection] =
    useState<SubagentTaskSelection | null>(null)
  const [rightSidebarActivated, setRightSidebarActivated] = useState(false)
  const [rightSidebarTabFocusRequest, setRightSidebarTabFocusRequest] = useState(0)
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false)
  const [rightSidebarTabId, setRightSidebarTabId] = useState<'git' | 'subagent'>('subagent')
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
  const rightSidebarShellTriggerRef = useRef<HTMLButtonElement>(null)
  const mainChatRef = useRef<HTMLElement>(null)
  const timelineStabilizeRef = useRef<(() => void) | null>(null)
  const subagentTaskDetailRef = useRef<HTMLElement>(null)
  const handleComposerMeasuredHeightChange = useCallback((height: number) => {
    const mainChat = mainChatRef.current
    if (mainChat === null) return
    if (height > 0) {
      mainChat.style.setProperty('--composer-measured-clearance', `${height}px`)
    } else {
      mainChat.style.removeProperty('--composer-measured-clearance')
    }
    timelineStabilizeRef.current?.()
  }, [])
  const handleTimelineLayoutStabilizeReady = useCallback((stabilize: (() => void) | null) => {
    timelineStabilizeRef.current = stabilize
  }, [])
  const restoreSettingsFocusRef = useRef(false)
  const composerControlRevisionRef = useRef(0)
  const rightSidebarResizeCancelRef = useRef<(() => void) | null>(null)
  const focusRestorationRevisionRef = useRef(0)
  const invalidateRightSidebarFocusRestoration = useCallback(() => {
    focusRestorationRevisionRef.current += 1
  }, [])
  const restoreRightSidebarTriggerFocus = useCallback((
    tabId: 'git' | 'subagent',
    selection: SubagentTaskSelection | null
  ) => {
    const requestRevision = ++focusRestorationRevisionRef.current
    requestAnimationFrame(() => {
      const mainChat = mainChatRef.current
      if (
        requestRevision !== focusRestorationRevisionRef.current ||
        hasConnectedMeaningfulFocus(mainChat)
      ) return
      const trigger = tabId === 'git'
        ? rightSidebarShellTriggerRef.current
        : mainChat === null || selection === null
          ? null
          : findSubagentTaskTrigger(mainChat, selection)
      if (trigger?.isConnected) trigger.focus()
      else mainChat?.focus()
    })
  }, [])
  const restoreSubagentTaskTriggerFocus = useCallback((selection: SubagentTaskSelection | null) => {
    restoreRightSidebarTriggerFocus('subagent', selection)
  }, [restoreRightSidebarTriggerFocus])
  const handleRightSidebarResizeCancelChange = useCallback((cancel: (() => void) | null) => {
    rightSidebarResizeCancelRef.current = cancel
  }, [])
  const collapseRightSidebar = useCallback(() => {
    setRightSidebarCollapsed(true)
    restoreRightSidebarTriggerFocus(rightSidebarTabId, subagentTaskSelection)
  }, [restoreRightSidebarTriggerFocus, rightSidebarTabId, subagentTaskSelection])
  const closeRightSidebar = useCallback((restoreFocus: boolean) => {
    const activeTabId = rightSidebarTabId
    const selection = subagentTaskSelection
    setRightSidebarActivated(false)
    setRightSidebarTabFocusRequest(0)
    setSubagentTaskSelection(null)
    setRightSidebarCollapsed(false)
    if (restoreFocus) restoreRightSidebarTriggerFocus(activeTabId, selection)
  }, [restoreRightSidebarTriggerFocus, rightSidebarTabId, subagentTaskSelection])
  useEffect(() => {
    if (settingsOpen || !restoreSettingsFocusRef.current) return
    restoreSettingsFocusRef.current = false
    settingsButtonRef.current?.focus()
  }, [settingsOpen])
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape' && rightSidebarResizeCancelRef.current !== null) {
        rightSidebarResizeCancelRef.current()
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (
        !document.hasFocus() ||
        event.defaultPrevented ||
        shortcutRecording ||
        hasVisibleShortcutBlockingSurface()
      ) return
      if (settingsOpen && event.key === 'Escape') {
        if (requestCloseSettings()) restoreSettingsFocusRef.current = true
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (subagentTaskSelection !== null && !rightSidebarCollapsed && event.key === 'Escape') {
        closeRightSidebar(true)
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (gitSidebarAvailable && !rightSidebarCollapsed && event.key === 'Escape') {
        closeRightSidebar(true)
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
    window.addEventListener('keydown', handleShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleShortcut, { capture: true })
  })
  const doubleClickBorderMaximize = state.general.doubleClickBorderMaximize !== false
  const handleWindowEdgeDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!doubleClickBorderMaximize || event.defaultPrevented || event.button !== 0) return
    if (typeof window.piGui.toggleMaximize !== 'function') return
    event.preventDefault()
    event.stopPropagation()
    void window.piGui.toggleMaximize().catch(() => undefined)
  }
  const userProjects = projects.filter((project) => project.workspaceKind !== 'task')
  const taskWorkspaces = projects.filter((project) => project.workspaceKind === 'task')
  const activeWorkspace = activeProjectKey === null
    ? null
    : projects.find((project) => project.path === activeProjectKey) ?? null
  const navigatorKind: KernelNavigatorKind = state.navigatorKind ??
    (activeWorkspace?.workspaceKind === 'task' ? 'task' : 'project')
  const displayedProjects = userProjects
    .map((project, index) => ({ project, index }))
    .sort((left, right) => {
      const pinOrder = Number(pinnedProjectKeys.has(right.project.path)) -
        Number(pinnedProjectKeys.has(left.project.path))
      return pinOrder === 0 ? left.index - right.index : pinOrder
    })
    .map(({ project }) => project)
  const activeProject = activeWorkspace?.workspaceKind === 'task' ? null : activeWorkspace
  const normalProjectActive = navigatorKind === 'project' && activeProject !== null
  const taskItems = taskWorkspaces.flatMap((workspace) => {
    if (workspace.taskKey === undefined) return []
    return (workspace.sessions ?? []).map((session) => ({
      taskKey: workspace.taskKey!,
      workspaceKey: workspace.path,
      session
    }))
  })
  const orderedTaskItems = orderTaskItems(taskItems)
  const projectBusyCount = userProjects.reduce(
    (count, project) => count + (project.busySessionCount ?? 0),
    0
  )
  const taskBusyCount = taskWorkspaces.reduce(
    (count, task) => count + (task.busySessionCount ?? 0),
    0
  )
  const displayedSessionKey = viewingNewSession
    ? null
    : viewedSessionKey ?? activeSessionKey
  const viewingInactiveSession =
    viewedSessionKey !== null && viewedSessionKey !== activeSessionKey
  const activeSession = displayedSessionKey === null
    ? null
    : sessions.find((summary) => summary.key === displayedSessionKey) ?? null
  const viewingArchivedSession = archivedSessionPreview !== null
  const projectName = activeWorkspace?.workspaceKind === 'task'
    ? '任务'
    : basename(activeProject?.path ?? null) ?? '未选择项目'
  const busy = pendingAction !== null
  const interactionBusy = busy || historyPromptEditing
  const canChangeProjectOrSession = !interactionBusy
  const canStartSession = canChangeProjectOrSession && activeProject !== null
  const displayingAuthoritativeConversation =
    archivedSessionPreview === null &&
    sessionPreview === null &&
    !viewingInactiveSession &&
    (!viewingNewSession || newSessionPrepared)
  const displayedConversation = archivedSessionPreview?.conversation ?? (
    viewingNewSession && !newSessionPrepared
    ? { entries: [], activeRunStartIndex: null }
    : sessionPreview?.conversation ?? (
        viewingInactiveSession
          ? { entries: [], activeRunStartIndex: null }
          : timelineConversation(conversation)
      )
  )
  const hasEarlierAuthoritativeConversation =
    displayingAuthoritativeConversation &&
    !viewingNewSession &&
    activeSessionKey !== null &&
    conversation.startIndex > 0
  const displayedTodos = currentTurnTodos(displayedConversation.entries)
  const displayedConversationIdentity = workbenchConversationIdentity({
    activeProjectKey,
    displayedSessionKey,
    viewingNewSession,
    archivedSessionKey: archivedSessionPreview?.sessionKey ?? null
  })
  useEffect(() => {
    setHistoryPromptEditing(false)
  }, [displayedConversationIdentity])
  const reconciledSubagentTaskSelection = settingsOpen
    ? null
    : reconcileSubagentTaskSelection(
        displayedConversation.entries,
        displayedConversationIdentity,
        subagentTaskSelection
      )
  const selectedSubagentTask = resolveSubagentTaskSelection(
    displayedConversation.entries,
    displayedConversationIdentity,
    reconciledSubagentTaskSelection
  )
  const selectedSubagentTaskKey = reconciledSubagentTaskSelection === null
    ? null
    : subagentTaskSelectionKey(reconciledSubagentTaskSelection)
  const gitSidebarAvailable = rightSidebarActivated && normalProjectActive && !settingsOpen
  const rightSidebarTabIds: Array<'git' | 'subagent'> = [
    ...(gitSidebarAvailable ? ['git' as const] : []),
    ...(selectedSubagentTask !== null ? ['subagent' as const] : [])
  ]
  const activeRightSidebarTabId = rightSidebarTabIds.length === 0
    ? null
    : reconcileRightSidebarActiveTab(rightSidebarTabIds, rightSidebarTabId) as 'git' | 'subagent'
  const rightSidebarHasModules = activeRightSidebarTabId !== null
  const rightSidebarOpen = rightSidebarHasModules && !rightSidebarCollapsed
  const rightSidebarToggleAvailable = normalProjectActive || rightSidebarHasModules
  useLayoutEffect(() => {
    if (activeRightSidebarTabId !== null && activeRightSidebarTabId !== rightSidebarTabId) {
      setRightSidebarTabId(activeRightSidebarTabId)
    }
  }, [activeRightSidebarTabId, rightSidebarTabId])
  useEffect(() => {
    if (!settingsOpen && normalProjectActive) return
    setRightSidebarActivated(false)
    setRightSidebarTabFocusRequest(0)
  }, [normalProjectActive, settingsOpen])
  useLayoutEffect(() => {
    timelineStabilizeRef.current?.()
  }, [rightSidebarOpen, selectedSubagentTaskKey, sidebarCollapsed])
  useLayoutEffect(() => {
    invalidateRightSidebarFocusRestoration()
  }, [displayedConversationIdentity, invalidateRightSidebarFocusRestoration, settingsOpen])
  const openSubagentTaskDetail = useCallback((
    target: SubagentTaskTarget,
    _trigger: HTMLButtonElement
  ): void => {
    invalidateRightSidebarFocusRestoration()
    setRightSidebarCollapsed(false)
    setRightSidebarTabId('subagent')
    setSubagentTaskSelection({
      conversationIdentity: displayedConversationIdentity,
      ...target
    })
  }, [displayedConversationIdentity, invalidateRightSidebarFocusRestoration])
  const toggleRightSidebar = useCallback((): void => {
    invalidateRightSidebarFocusRestoration()
    if (rightSidebarOpen) {
      setRightSidebarCollapsed(true)
      return
    }
    if (!rightSidebarHasModules) {
      if (!normalProjectActive) return
      setRightSidebarActivated(true)
    }
    setRightSidebarCollapsed(false)
    setRightSidebarTabFocusRequest((current) => current + 1)
  }, [
    invalidateRightSidebarFocusRestoration,
    normalProjectActive,
    rightSidebarHasModules,
    rightSidebarOpen
  ])
  useEffect(() => {
    if (subagentTaskSelection === null) return
    if (
      settingsOpen ||
      subagentTaskSelection.conversationIdentity !== displayedConversationIdentity
    ) {
      setSubagentTaskSelection(null)
      return
    }
    if (reconciledSubagentTaskSelection !== null) return
    setSubagentTaskSelection(null)
    if (gitSidebarAvailable) {
      setRightSidebarTabId('git')
      setRightSidebarTabFocusRequest((current) => current + 1)
      return
    }
    restoreSubagentTaskTriggerFocus(subagentTaskSelection)
  }, [
    displayedConversationIdentity,
    gitSidebarAvailable,
    reconciledSubagentTaskSelection,
    restoreSubagentTaskTriggerFocus,
    settingsOpen,
    subagentTaskSelection
  ])
  useEffect(() => {
    if (
      !rightSidebarOpen ||
      activeRightSidebarTabId !== 'subagent' ||
      selectedSubagentTaskKey === null
    ) return
    subagentTaskDetailRef.current?.focus()
  }, [activeRightSidebarTabId, rightSidebarOpen, selectedSubagentTaskKey])
  const canUseSettledSessionActions =
    !viewingArchivedSession &&
    sessionPreview === null &&
    !viewingInactiveSession &&
    !viewingNewSession &&
    activeSessionKey !== null &&
    runtime.status === 'ready' &&
    state.session.settled
  const canForkSession = canUseSettledSessionActions && activeWorkspace?.workspaceKind !== 'task'
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
  const canCopyLastAnswer = canUseSettledSessionActions
  const settingsState = activeWorkspace?.workspaceKind === 'task'
    ? { ...state, activeProjectKey: null }
    : state
  const conversationActionStatus =
    isWorkbenchAction(pendingAction, 'export-session')
      ? '正在导出 HTML…'
      : isWorkbenchAction(pendingAction, 'copy-last-answer')
        ? '正在复制回答…'
        : pendingAction === null &&
          completedAction !== null &&
          isWorkbenchAction(completedAction.action, 'copy-last-answer') &&
          completedAction.succeeded
          ? '已复制回答'
          : null
  const contextActionStatus = runtimeContextActionStatus(pendingAction)
  const extensionActionError = settingsOpen &&
    settingsSection === 'extensions' &&
    actionFailure?.owner === 'extension'
    ? actionFailure.message
    : null
  const settingsActionError = settingsOpen &&
    actionFailure?.owner === settingsSection
    ? actionFailure.message
    : null
  const timelineActionError = !settingsOpen &&
    actionFailure?.owner === 'timeline'
    ? actionFailure.message
    : null
  const conversationActionError = !settingsOpen &&
    actionFailure?.owner === 'conversation-actions'
    ? actionFailure.message
    : null
  const headerActionError = !settingsOpen &&
    actionFailure?.owner === 'header'
    ? actionFailure.message
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
    invalidateRightSidebarFocusRestoration()
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

    // Historical targets publish their cached shell now, then share one dwell so
    // rapid browsing starts preview/activation only for the latest selection.
    void onSelectSession(sessionKey).catch(() => undefined)
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
      invalidateRightSidebarFocusRestoration()
      if (viewingArchivedSession) onClearArchivedSessionPreview()
      setSidebarCollapsed(false)
      openSettings()
      return true
    }
    if (actionId === 'new-session') {
      if (interactionBusy || (navigatorKind === 'project' && !canStartSession)) return false
      if (settingsOpen && !requestCloseSettings()) return false
      invalidateRightSidebarFocusRestoration()
      void (navigatorKind === 'task' ? onCreateTask() : onStartSession()).catch(() => undefined)
      return true
    }
    if (actionId === 'focus-composer') {
      const displayedStatus = viewingInactiveSession
        ? activeSession?.runtimeStatus ?? 'stopped'
        : runtime.status
      if (
        interactionBusy ||
        viewingArchivedSession ||
        activeWorkspace === null ||
        (displayedStatus !== 'ready' && displayedStatus !== 'running')
      ) return false
      if (settingsOpen && !requestCloseSettings()) return false
      requestComposerControl('focus')
      return true
    }
    if (actionId === 'open-model-selector') {
      if (
        interactionBusy ||
        viewingArchivedSession ||
        viewingInactiveSession ||
        (viewingNewSession && !newSessionPrepared) ||
        (!viewingNewSession && activeSessionKey === null) ||
        runtime.status !== 'ready'
      ) return false
      if (settingsOpen && !requestCloseSettings()) return false
      requestComposerControl('open-model-picker')
      return true
    }
    if (actionId === 'reload-session') {
      if (
        interactionBusy ||
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
        interactionBusy ||
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
        interactionBusy ||
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
      if (interactionBusy || navigatorKind !== 'project' || activeProjectKey === null) return false
      const currentIndex = displayedProjects.findIndex(({ path }) => path === activeProjectKey)
      const targetIndex = currentIndex + (actionId === 'previous-project' ? -1 : 1)
      const target = displayedProjects[targetIndex]
      if (target === undefined) return false
      invalidateRightSidebarFocusRestoration()
      void onActivateProject(target.path).catch(() => undefined)
      return true
    }
    if (interactionBusy || displayedSessionKey === null) return false
    if (navigatorKind === 'task') {
      const currentIndex = orderedTaskItems.findIndex(
        ({ session }) => session.key === displayedSessionKey
      )
      const targetIndex = currentIndex + (actionId === 'previous-session' ? -1 : 1)
      const target = orderedTaskItems[targetIndex]
      if (target === undefined) return false
      invalidateRightSidebarFocusRestoration()
      void onActivateTask(target.taskKey, target.session.key).catch(() => undefined)
      return true
    }
    const currentIndex = sessions.findIndex(({ key }) => key === displayedSessionKey)
    const targetIndex = currentIndex + (actionId === 'previous-session' ? -1 : 1)
    const target = sessions[targetIndex]
    if (target === undefined) return false
    openSession(target.key, target.runtimeStatus)
    return true
  }
  return (
    <main className={`app-shell${sidebarCollapsed ? ' left-sidebar-collapsed' : ''}${settingsOpen ? ' settings-open' : ''}${rightSidebarOpen ? ' right-sidebar-open' : ''}`}>
      {doubleClickBorderMaximize ? (
        <div className="window-edge-hit-layer" aria-hidden="true">
          <div className="window-edge-hit top" onDoubleClick={handleWindowEdgeDoubleClick} />
          <div className="window-edge-hit right" onDoubleClick={handleWindowEdgeDoubleClick} />
          <div className="window-edge-hit bottom" onDoubleClick={handleWindowEdgeDoubleClick} />
          <div className="window-edge-hit left" onDoubleClick={handleWindowEdgeDoubleClick} />
        </div>
      ) : null}
      <aside className="left-sidebar" aria-label={settingsOpen ? '设置导航' : '项目与任务'}>
        <div className={`sidebar-content${settingsOpen ? ' settings-sidebar-content' : ''}`}>
          {settingsOpen ? (
            <SettingsNavigation
              section={settingsSection}
              onSectionChange={(section) => {
                invalidateRightSidebarFocusRestoration()
                requestSectionChange(section)
              }}
              onBack={() => {
                if (requestCloseSettings()) restoreSettingsFocusRef.current = true
              }}
            />
          ) : null}
          <WorkspaceNavigatorGroup
            hidden={settingsOpen}
            kind="project"
            contentId="project-navigator-panel"
            label="项目"
            expanded={projectNavigatorExpanded}
            active={navigatorKind === 'project'}
            busyCount={projectBusyCount}
            addLabel="添加项目"
            addBusy={isWorkbenchAction(pendingAction, 'add-project')}
            addDisabled={!canChangeProjectOrSession}
            onToggle={() => setProjectNavigatorExpanded((current) => !current)}
            onAdd={onAddProject}
          >
            <ProjectNavigator
              hidden={settingsOpen || !projectNavigatorExpanded}
              projects={displayedProjects}
              activeProjectKey={activeProject?.path ?? null}
              activeSessionKey={activeSessionKey}
              sessions={sessions}
              displayedSessionKey={displayedSessionKey}
              viewedSessionKey={viewedSessionKey}
              viewingArchivedSession={viewingArchivedSession}
              sidebarCollapsed={sidebarCollapsed}
              busy={interactionBusy}
              canChangeProjectOrSession={canChangeProjectOrSession}
              sessionPreviewPending={sessionPreviewPending}
              pendingAction={pendingAction}
              contextActionStatus={contextActionStatus}
              tokenCountFormat={state.appearance.tokenCountFormat}
              pinnedProjectKeys={pinnedProjectKeys}
              onTogglePinnedProject={togglePinnedProject}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              onClearArchivedSessionPreview={onClearArchivedSessionPreview}
              onActivateProject={(projectKey) => {
                invalidateRightSidebarFocusRestoration()
                return onActivateProject(projectKey)
              }}
              onStartSession={() => {
                invalidateRightSidebarFocusRestoration()
                return onStartSession()
              }}
              onOpenSession={openSession}
              onArchiveSession={onArchiveSession}
              onReorderProjects={onReorderProjects}
            />
          </WorkspaceNavigatorGroup>
          <WorkspaceNavigatorGroup
            hidden={settingsOpen}
            kind="task"
            contentId="task-navigator-panel"
            label="任务"
            expanded={taskNavigatorExpanded}
            active={navigatorKind === 'task'}
            busyCount={taskBusyCount}
            addLabel="新建任务"
            addBusy={
              isWorkbenchAction(pendingAction, 'create-task') ||
              isWorkbenchAction(pendingAction, 'start-session')
            }
            addDisabled={!canChangeProjectOrSession}
            onToggle={() => setTaskNavigatorExpanded((current) => !current)}
            onAdd={() => {
              invalidateRightSidebarFocusRestoration()
              return onCreateTask()
            }}
          >
            <TaskNavigator
              hidden={settingsOpen || !taskNavigatorExpanded}
              tasks={orderedTaskItems}
              activeWorkspaceKey={activeWorkspace?.workspaceKind === 'task' ? activeWorkspace.path : null}
              displayedSessionKey={displayedSessionKey}
              viewedSessionKey={viewedSessionKey}
              viewingArchivedSession={viewingArchivedSession}
              busy={interactionBusy}
              canChangeProjectOrSession={canChangeProjectOrSession}
              sessionPreviewPending={sessionPreviewPending}
              pendingAction={pendingAction}
              contextActionStatus={contextActionStatus}
              tokenCountFormat={state.appearance.tokenCountFormat}
              onClearArchivedSessionPreview={onClearArchivedSessionPreview}
              onActivateTask={(taskKey, sessionKey) => {
                invalidateRightSidebarFocusRestoration()
                return onActivateTask(taskKey, sessionKey)
              }}
              onOpenSession={openSession}
              onArchiveSession={onArchiveSession}
            />
          </WorkspaceNavigatorGroup>
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
              ref={settingsButtonRef}
              className="sidebar-settings-toggle"
              icon="settings"
              iconSize="lg"
              label="设置"
              aria-pressed={false}
              onClick={() => {
                invalidateRightSidebarFocusRestoration()
                if (viewingArchivedSession) onClearArchivedSessionPreview()
                setSidebarCollapsed(false)
                openSettings()
              }}
            />
          </footer>
        )}
      </aside>

      <section
        className="main-chat"
        ref={mainChatRef}
        tabIndex={-1}
        aria-label={`${projectName}${navigatorKind === 'task' ? '' : ' 对话'}工作区`}
      >
        {operationNotifications}
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
            state={settingsState}
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
            packageInstallJobs={packageInstallJobs}
            onInstallPiDevPackage={onInstallPiDevPackage}
            onRemovePiPackage={onRemovePiPackage}
            onUpdatePiPackage={onUpdatePiPackage}
            onUpdatePiPackages={onUpdatePiPackages}
            onOpenExternal={onOpenExternal}
            onCreateSkill={async (prompt) => {
              await promptInDisplayedSession(prompt)
              requestCloseSettings()
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
            onSetModel={(provider, modelId) => onSetModel(provider, modelId, 'settings')}
            onSetSessionNaming={onSetSessionNaming}
            onSetGeneral={onSetGeneral}
            onSetSubagentEnabled={onSetSubagentEnabled}
            onSetMagicContextEnabled={onSetMagicContextEnabled}
            onListSubagentDefinitions={onListSubagentDefinitions}
            onSaveSubagentDefinition={onSaveSubagentDefinition}
            onSetSubagentDefinitionEnabled={onSetSubagentDefinitionEnabled}
            onRemoveSubagentDefinition={onRemoveSubagentDefinition}
            onSetSubagent={onSetSubagent}
            onSetAppearance={onSetAppearance}
            onSetShortcuts={onSetShortcuts}
            onShortcutRecordingChange={setShortcutRecording}
            toolDisplayDensity={toolDisplayDensity}
            onSetToolDisplayDensity={(density) => {
              setToolDisplayDensity(density)
              window.localStorage.setItem(TOOL_DISPLAY_DENSITY_STORAGE_KEY, density)
            }}
            onDirtyChange={onDirtyChange}
            onActiveOperationChange={onActiveOperationChange}
          />
        ) : (
          <>
        <header className="workbench-session-header">
          <div className="workbench-session-primary">
            <div className="workbench-session-heading">
              <span className="workbench-session-scope">
                {navigatorKind === 'task' ? '任务' : projectName}
              </span>
              <span className="workbench-session-separator" aria-hidden="true">/</span>
              <strong className="workbench-session-title">
                {archivedSessionPreview !== null
                  ? archivedSessionPreview.sessionName ?? `对话 ${archivedSessionPreview.sessionId.slice(0, 8)}`
                  : viewingNewSession
                  ? navigatorKind === 'task' ? '新任务' : '新对话'
                  : activeSession === null
                    ? navigatorKind === 'task' ? '尚未选择任务' : '尚未选择对话'
                    : sessionTitle(activeSession)}
              </strong>
            </div>
            {!rightSidebarToggleAvailable ? null : (
              <IconButton
                ref={rightSidebarShellTriggerRef}
                className="workbench-header-right-sidebar-toggle"
                icon={rightSidebarOpen ? 'right-sidebar-close' : 'right-sidebar-open'}
                iconSize="lg"
                label={rightSidebarOpen ? '收起右侧栏' : '展开右侧栏'}
                aria-controls={RIGHT_SIDEBAR_ID}
                aria-expanded={rightSidebarOpen}
                onClick={toggleRightSidebar}
              />
            )}
          </div>
          {archivedSessionPreview !== null ? (
            <span className="archived-preview-status" role="status">
              已归档 · 临时只读
              <IconButton
                className="archived-preview-exit"
                icon="close"
                iconSize="sm"
                label="退出归档预览"
                onClick={onClearArchivedSessionPreview}
              />
            </span>
          ) : sessionPreview !== null && viewingInactiveSession && !sessionPreviewPending ? (
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
          key={displayedConversationIdentity}
          entries={displayedConversation.entries}
          activeRunStartIndex={displayedConversation.activeRunStartIndex}
          runtimeStatus={viewingArchivedSession
            ? 'stopped'
            : viewingInactiveSession
            ? activeSession?.runtimeStatus ?? 'ready'
            : runtime.status}
          loading={sessionPreviewPending}
          compactionActive={
            !viewingArchivedSession &&
            !viewingInactiveSession &&
            !viewingNewSession &&
            state.session.compaction !== null
          }
          showPromptNavigation={!sidebarCollapsed}
          toolDisplayDensity={toolDisplayDensity}
          sessionKey={
            archivedSessionPreview?.sessionKey ??
            sessionPreview?.sessionKey ??
            displayedSessionKey
          }
          askSessionKey={
            !viewingArchivedSession &&
            !viewingInactiveSession &&
            !viewingNewSession
              ? activeSessionKey
              : null
          }
          canCopyAnswers={canCopyLastAnswer}
          canExportSession={canExportSession}
          canForkSession={canForkSession}
          canEditHistoryPrompt={canForkSession}
          hasEarlierConversation={hasEarlierAuthoritativeConversation}
          conversationActionBusy={busy}
          conversationActionStatus={conversationActionStatus}
          conversationActionError={conversationActionError}
          onCopyAnswer={onCopyAnswer}
          onExportSession={onExportSession}
          onLoadEarlierConversation={onLoadEarlierConversation}
          onForkTurn={onOpenForkDialog}
          onNavigateHistoryPrompt={(messageId) => {
            if (activeSessionKey === null) {
              return Promise.reject(new Error('No active Session is available.'))
            }
            return onNavigateHistoryPrompt(activeSessionKey, messageId)
          }}
          onSendHistoryPrompt={(message) => {
            if (activeSessionKey === null) {
              return Promise.reject(new Error('No active Session is available.'))
            }
            return onPrompt(message, undefined, activeSessionKey)
          }}
          onHistoryPromptEditingChange={setHistoryPromptEditing}
          subagentTaskSelection={
            rightSidebarOpen && activeRightSidebarTabId === 'subagent'
              ? reconciledSubagentTaskSelection
              : null
          }
          onOpenSubagentTask={openSubagentTaskDetail}
          onSubmitAsk={onSubmitAsk}
          onCancelAsk={onCancelAsk}
          onLayoutStabilizeReady={handleTimelineLayoutStabilizeReady}
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
          busy={interactionBusy}
          pendingAction={pendingAction}
          completedAction={completedAction}
          todos={displayedTodos}
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
          globalEscapeAbortEnabled={!rightSidebarOpen}
          onSetModel={(provider, modelId) => onSetModel(provider, modelId, 'conversation')}
          onSetThinkingLevel={onSetThinkingLevel}
          onSetOpenAiFastMode={onSetOpenAiFastMode}
          onMeasuredHeightChange={handleComposerMeasuredHeightChange}
        />}
          </>
        )}
      </section>

      {!rightSidebarOpen || activeRightSidebarTabId === null ? null : (
        <RightSidebar
          activeTabId={activeRightSidebarTabId}
          tabs={[
            ...(gitSidebarAvailable ? [{
              id: 'git',
              label: 'Git',
              content: <GitChangesPanel projectKey={activeProject.path} />
            }] : []),
            ...(selectedSubagentTask === null ? [] : [{
              id: 'subagent',
              label: '子任务',
              content: (
                <SubagentTaskDetail
                  entry={selectedSubagentTask.entry}
                  participant={selectedSubagentTask.participant}
                  tokenCountFormat={state.appearance.tokenCountFormat}
                  panelRef={subagentTaskDetailRef}
                />
              )
            }])
          ]}
          focusActiveTabRequest={rightSidebarTabFocusRequest}
          onTabChange={(tabId) => {
            if (tabId !== 'git' && tabId !== 'subagent') {
              throw new Error(`Unknown right sidebar tab: ${JSON.stringify(tabId)}.`)
            }
            invalidateRightSidebarFocusRestoration()
            setRightSidebarTabId(tabId)
          }}
          onCollapse={collapseRightSidebar}
          onClose={() => closeRightSidebar(true)}
          onResizeCancelChange={handleRightSidebarResizeCancelChange}
        />
      )}

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
          preferredUserText={forkPreferredUserText}
          onCancel={onCloseForkDialog}
          onRetry={onRetryForkCandidates}
          onSubmit={onForkSession}
        />
      ) : null}
    </main>
  )
}

type WorkspaceNavigatorGroupProps = {
  hidden: boolean
  kind: KernelNavigatorKind
  contentId: string
  label: string
  expanded: boolean
  active: boolean
  busyCount: number
  addLabel: string
  addBusy: boolean
  addDisabled: boolean
  onToggle: () => void
  onAdd: () => Promise<void>
  children: ReactNode
}

function WorkspaceNavigatorGroup({
  hidden,
  kind,
  contentId,
  label,
  expanded,
  active,
  busyCount,
  addLabel,
  addBusy,
  addDisabled,
  onToggle,
  onAdd,
  children
}: WorkspaceNavigatorGroupProps): React.JSX.Element {
  const toggleId = `${contentId}-toggle`
  return (
    <div
      className="workspace-navigator-group"
      data-kind={kind}
      hidden={hidden}
    >
      <div className="workspace-navigator-group-header">
        <button
          id={toggleId}
          className="workspace-navigator-group-toggle"
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          data-active={active ? 'true' : undefined}
          onClick={onToggle}
        >
          <span className="workspace-navigator-group-chevron" aria-hidden="true">
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
          </span>
          <span className="workspace-navigator-group-label">{label}</span>
          {busyCount > 0 ? (
            <span
              className="navigator-busy-count"
              aria-label={`${busyCount} 个进行中`}
            >
              <span className="navigator-busy-count-text">{busyCount}</span>
            </span>
          ) : null}
        </button>
        <div className="workspace-navigator-group-action-slot">
          <IconButton
            className="workspace-navigator-group-add"
            icon="plus"
            label={addLabel}
            aria-busy={addBusy ? true : undefined}
            disabled={addDisabled}
            onClick={() => void onAdd().catch(() => undefined)}
          />
        </div>
      </div>
      {children}
    </div>
  )
}

function hasConnectedMeaningfulFocus(mainChat: HTMLElement | null): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement &&
    active.isConnected &&
    active !== document.body &&
    active !== document.documentElement &&
    active !== mainChat
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

function findSubagentTaskTrigger(
  root: HTMLElement,
  selection: SubagentTaskSelection
): HTMLButtonElement | null {
  const candidates = [...root.querySelectorAll<HTMLButtonElement>(
    SUBAGENT_TASK_TRIGGER_SELECTOR
  )]
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (candidate === undefined) continue
    if (matchesSubagentTaskTrigger(selection, {
      kind: candidate.dataset.subagentTaskKind ?? null,
      toolCallId: candidate.dataset.subagentToolCallId ?? null,
      participantIndex: candidate.dataset.subagentParticipantIndex ?? null,
      noticeId: candidate.dataset.subagentNoticeId ?? null
    })) return candidate
  }
  return null
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
