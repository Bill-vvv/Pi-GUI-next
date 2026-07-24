import { useEffect, useRef, useState } from 'react'

import type {
  AppearanceSettings,
  GeneralSettings,
  KernelPromptAttachment,
  KernelSessionPreview,
  KernelStatePatch,
  KernelState,
  SessionNamingSettings,
  ThinkingLevel
} from '../../shared/kernel-contract'
import { Workbench } from './composition/Workbench'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SessionViewTarget =
  | {
      kind: 'session'
      projectKey: string
      sessionKey: string
    }
  | {
      kind: 'new'
      projectKey: string
      prepared: boolean
      sawProvisional: boolean
    }

export function App(): React.JSX.Element {
  const [kernelState, setKernelState] = useState<KernelState | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [sessionPreview, setSessionPreview] = useState<KernelSessionPreview | null>(null)
  const [sessionViewTarget, setSessionViewTarget] = useState<SessionViewTarget | null>(null)
  const [previewPendingKey, setPreviewPendingKey] = useState<string | null>(null)
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null)
  const [completedAction, setCompletedAction] = useState<{
    action: string
    succeeded: boolean
  } | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const kernelStateRef = useRef<KernelState | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const sessionViewTargetRef = useRef<SessionViewTarget | null>(null)
  const previewRequestRevision = useRef(0)
  const sessionStartPromiseRef = useRef<Promise<void> | null>(null)
  const coldStartHandledRef = useRef(false)
  const eventRevision = useRef(0)
  const actionPresentationRevision = useRef(0)

  useEffect(() => {
    let active = true
    void window.piGui.listSystemFonts().then(
      (fonts) => {
        if (!active) return
        setSystemFonts(fonts)
        setSystemFontsError(null)
      },
      (error: unknown) => {
        if (!active) return
        setSystemFontsError(errorMessage(error))
      }
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const rootStyle = document.documentElement.style
    applySelectedFont(rootStyle, '--font-ui-selected', kernelState?.appearance.uiFontFamily ?? null)
    applySelectedFont(rootStyle, '--font-code-selected', kernelState?.appearance.codeFontFamily ?? null)
    const textSize = kernelState?.appearance.textSize ?? 'default'
    rootStyle.setProperty('--text-root', textSize === 'small' ? '14px' : textSize === 'large' ? '16px' : '15px')
  }, [kernelState?.appearance])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.accent = kernelState?.appearance.accentColor ?? 'amber'
    root.style.setProperty(
      '--surface-transparency',
      `${kernelState?.appearance.surfaceTransparency ?? 20}%`
    )
  }, [kernelState?.appearance.accentColor, kernelState?.appearance.surfaceTransparency])

  useEffect(() => {
    const preference = kernelState?.appearance.theme ?? 'system'
    const systemTheme = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = (): void => {
      document.documentElement.dataset.theme = preference === 'system'
        ? systemTheme.matches ? 'light' : 'dark'
        : preference
    }

    applyTheme()
    if (preference !== 'system') return
    systemTheme.addEventListener('change', applyTheme)
    return () => systemTheme.removeEventListener('change', applyTheme)
  }, [kernelState?.appearance.theme])

  useEffect(() => {
    let active = true
    let pendingPatches: KernelStatePatch[] = []
    let framePatches: KernelStatePatch[] = []
    let renderFrame: number | null = null
    let unsubscribe = (): void => undefined

    const commitImmediately = (state: KernelState): void => {
      const initializing = kernelStateRef.current === null
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame)
        renderFrame = null
      }
      framePatches = []
      kernelStateRef.current = state
      setKernelState(state)
      const nextTarget = initializing && state.activeProjectKey !== null
        ? {
            kind: 'new' as const,
            projectKey: state.activeProjectKey,
            prepared: false,
            sawProvisional: state.activeSessionKey === null
          }
        : keepValidSessionViewTarget(sessionViewTargetRef.current, state)
      sessionViewTargetRef.current = nextTarget
      setSessionViewTarget(nextTarget)
      setSessionPreview((preview) => keepValidPreview(preview, state))
    }

    const schedulePatch = (patch: KernelStatePatch): void => {
      framePatches.push(patch)
      if (renderFrame !== null) return
      renderFrame = requestAnimationFrame(() => {
        renderFrame = null
        const state = kernelStateRef.current
        const patches = framePatches
        framePatches = []
        if (!active || state === null) return
        const nextState = applyStatePatches(state, patches)
        kernelStateRef.current = nextState
        setKernelState(nextState)
      })
    }

    try {
      unsubscribe = window.piGui.subscribe((event) => {
        if (!active) return
        eventRevision.current += 1
        if (event.type === 'kernel.state-changed') {
          pendingPatches = []
          commitImmediately(event.state)
        } else {
          const state = kernelStateRef.current
          if (state === null) pendingPatches.push(event.patch)
          else schedulePatch(event.patch)
        }
        setIpcError(null)
      })

      void window.piGui.getState().then(
        (state) => {
          if (!active) return
          if (kernelStateRef.current !== null) return
          const initialized = applyStatePatches(state, pendingPatches)
          pendingPatches = []
          commitImmediately(initialized)
          setIpcError(null)
        },
        (error: unknown) => {
          if (!active) return
          setIpcError(errorMessage(error))
        }
      )
    } catch (error: unknown) {
      setIpcError(errorMessage(error))
    }

    return () => {
      active = false
      if (renderFrame !== null) cancelAnimationFrame(renderFrame)
      unsubscribe()
    }
  }, [connectionAttempt])

  useEffect(() => {
    if (coldStartHandledRef.current || kernelState === null) return
    coldStartHandledRef.current = true
    if (
      kernelState.activeProjectKey === null ||
      kernelState.runtime.status !== 'stopped' ||
      sessionViewTargetRef.current?.kind !== 'new'
    ) return
    void startSession().catch(() => undefined)
  }, [kernelState])

  async function runAction(
    action: string,
    operation: () => Promise<KernelState>,
    exclusive = true
  ): Promise<void> {
    if (exclusive) {
      if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
      pendingActionRef.current = action
      setPendingAction(action)
    }
    const presentationRevision = actionPresentationRevision.current + 1
    actionPresentationRevision.current = presentationRevision
    setActionError(null)
    let succeeded = false
    const revisionBeforeAction = eventRevision.current
    try {
      const state = await operation()
      if (eventRevision.current === revisionBeforeAction) {
        kernelStateRef.current = state
        setKernelState(state)
      }
      succeeded = true
    } catch (error) {
      if (actionPresentationRevision.current === presentationRevision) {
        setActionError(errorMessage(error))
      }
      throw error
    } finally {
      if (actionPresentationRevision.current === presentationRevision) {
        setCompletedAction({ action, succeeded })
      }
      if (exclusive) {
        pendingActionRef.current = null
        setPendingAction(null)
      }
    }
  }

  async function previewSession(sessionKey: string): Promise<void> {
    const state = kernelStateRef.current
    if (state?.activeProjectKey === null || state?.activeProjectKey === undefined) {
      throw new Error('No active project is available.')
    }
    const requestRevision = previewRequestRevision.current + 1
    previewRequestRevision.current = requestRevision
    const target: SessionViewTarget = {
      kind: 'session',
      projectKey: state.activeProjectKey,
      sessionKey
    }
    sessionViewTargetRef.current = target
    setSessionViewTarget(target)
    setSessionPreview(null)
    setPreviewPendingKey(sessionKey)
    setActionError(null)
    try {
      const preview = await window.piGui.previewSession(sessionKey)
      if (
        previewRequestRevision.current !== requestRevision ||
        sessionViewTargetRef.current?.kind !== 'session' ||
        sessionViewTargetRef.current.sessionKey !== sessionKey
      ) return
      setSessionPreview(preview)
    } catch (error) {
      if (previewRequestRevision.current !== requestRevision) return
      setActionError(errorMessage(error))
      throw error
    } finally {
      if (previewRequestRevision.current === requestRevision) setPreviewPendingKey(null)
    }
  }

  function clearSessionView(): void {
    previewRequestRevision.current += 1
    sessionViewTargetRef.current = null
    setSessionViewTarget(null)
    setSessionPreview(null)
    setPreviewPendingKey(null)
    setActionError(null)
  }

  function startSession(): Promise<void> {
    if (sessionStartPromiseRef.current !== null) return sessionStartPromiseRef.current
    const projectKey = kernelStateRef.current?.activeProjectKey
    if (projectKey !== null && projectKey !== undefined) {
      previewRequestRevision.current += 1
      const target: SessionViewTarget = {
        kind: 'new',
        projectKey,
        prepared: false,
        sawProvisional: kernelStateRef.current?.activeSessionKey === null
      }
      sessionViewTargetRef.current = target
      setSessionViewTarget(target)
      setSessionPreview(null)
      setPreviewPendingKey(null)
      setActionError(null)
    }

    const operation = runAction('start-session', () => window.piGui.startSession()).then(() => {
      const target = sessionViewTargetRef.current
      if (target?.kind === 'new') {
        const preparedTarget = { ...target, prepared: true }
        sessionViewTargetRef.current = preparedTarget
        setSessionViewTarget(preparedTarget)
      }
    })
    sessionStartPromiseRef.current = operation
    void operation.then(
      () => {
        if (sessionStartPromiseRef.current === operation) sessionStartPromiseRef.current = null
      },
      () => {
        if (sessionStartPromiseRef.current === operation) sessionStartPromiseRef.current = null
      }
    )
    return operation
  }

  async function waitForSessionStart(): Promise<void> {
    const operation = sessionStartPromiseRef.current
    if (operation !== null) await operation
  }

  if (kernelState === null) {
    if (ipcError !== null) {
      return (
        <main className="screen-loading error">
          <div className="kernel-connection-error" role="alert">
            <span>无法连接 Workbench Kernel：{ipcError}</span>
            <button
              type="button"
              onClick={() => {
                setIpcError(null)
                setConnectionAttempt((attempt) => attempt + 1)
              }}
            >
              重试
            </button>
          </div>
        </main>
      )
    }
    return (
      <main className="screen-loading">
        正在连接 Pi Workbench…
      </main>
    )
  }

  return (
    <Workbench
      state={kernelState}
      sessionPreview={sessionPreview}
      viewedSessionKey={
        sessionViewTarget?.kind === 'session' ? sessionViewTarget.sessionKey : null
      }
      viewingNewSession={sessionViewTarget?.kind === 'new'}
      newSessionPrepared={
        sessionViewTarget?.kind === 'new' && sessionViewTarget.prepared
      }
      sessionPreviewPending={
        sessionViewTarget?.kind === 'session' &&
        previewPendingKey === sessionViewTarget.sessionKey
      }
      pendingAction={pendingAction}
      completedAction={completedAction}
      actionError={actionError ?? ipcError}
      systemFonts={systemFonts}
      systemFontsError={systemFontsError}
      onAddProject={() => runAction('add-project', () => window.piGui.addProject())}
      onActivateProject={async (projectKey) => {
        await runAction('activate-project', () => window.piGui.activateProject(projectKey))
        clearSessionView()
      }}
      onStartSession={startSession}
      onWaitForSessionStart={waitForSessionStart}
      onActivateSession={async (sessionKey) => {
        await runAction('activate-session', () => window.piGui.activateSession(sessionKey))
        clearSessionView()
      }}
      onPreviewSession={previewSession}
      onClearSessionPreview={clearSessionView}
      onArchiveSession={async (sessionKey) => {
        await runAction('archive-session', () => window.piGui.archiveSession(sessionKey))
        if (
          sessionViewTargetRef.current?.kind === 'session' &&
          sessionViewTargetRef.current.sessionKey === sessionKey
        ) clearSessionView()
        setSessionPreview((preview) =>
          preview?.sessionKey === sessionKey ? null : preview
        )
      }}
      onReorderProjects={(projectKeys) =>
        runAction('reorder-projects', () => window.piGui.reorderProjects(projectKeys))
      }
      onReorderSessions={(sessionKeys) =>
        runAction('reorder-sessions', () => window.piGui.reorderSessions(sessionKeys))
      }
      onInstallExtension={(kind) =>
        runAction('install-extension', () => window.piGui.installExtension(kind))
      }
      onRemoveExtension={(path) =>
        runAction('remove-extension', () => window.piGui.removeExtension(path))
      }
      onSearchPiDevExtensions={(query) => window.piGui.searchPiDevExtensions(query)}
      onSearchPiDevPackages={(query) => window.piGui.searchPiDevPackages(query)}
      onListPiPackages={() => window.piGui.listPiPackages()}
      onInstallPiDevPackage={(name) =>
        runAction('install-pi-dev-package', () => window.piGui.installPiDevPackage(name))
      }
      onRemovePiPackage={(source) =>
        runAction('remove-pi-package', () => window.piGui.removePiPackage(source))
      }
      onUpdatePiPackage={(source) =>
        runAction('update-pi-package', () => window.piGui.updatePiPackage(source))
      }
      onUpdatePiPackages={() =>
        runAction('update-pi-packages', () => window.piGui.updatePiPackages())
      }
      onOpenExternal={(url) => window.piGui.openExternal(url)}
      onListProviders={window.piGui.listProviders}
      onSaveProvider={window.piGui.saveProvider}
      onRemoveProvider={window.piGui.removeProvider}
      onTestProvider={window.piGui.testProvider}
      onSelectPromptAttachments={() => window.piGui.selectPromptAttachments()}
      onPrompt={(message, attachments?: KernelPromptAttachment[]) =>
        runAction('prompt', () => window.piGui.prompt(message, attachments), false)}
      onSteer={(message, attachments?: KernelPromptAttachment[]) =>
        runAction('steer', () => window.piGui.steer(message, attachments), false)}
      onFollowUp={(message, attachments?: KernelPromptAttachment[]) =>
        runAction('follow-up', () => window.piGui.followUp(message, attachments), false)}
      onInvokeCommand={(commandId, argument) =>
        runAction('invoke-command', () => window.piGui.invokeCommand(commandId, argument))
      }
      onAbort={() => runAction('abort', () => window.piGui.abort())}
      onSetModel={(provider, modelId) =>
        runAction('set-model', () => window.piGui.setModel(provider, modelId))
      }
      onSetThinkingLevel={(level: ThinkingLevel) =>
        runAction('set-thinking-level', () => window.piGui.setThinkingLevel(level))
      }
      onSetSessionNaming={(settings: SessionNamingSettings) =>
        runAction('set-session-naming', () => window.piGui.setSessionNaming(settings))
      }
      onSetGeneral={(settings: GeneralSettings) =>
        runAction('set-general', () => window.piGui.setGeneral(settings))
      }
      onSetAppearance={(settings: AppearanceSettings) =>
        runAction('set-appearance', () => window.piGui.setAppearance(settings))
      }
    />
  )
}

function applySelectedFont(
  style: CSSStyleDeclaration,
  property: '--font-ui-selected' | '--font-code-selected',
  fontFamily: string | null
): void {
  if (fontFamily === null) style.removeProperty(property)
  else style.setProperty(property, `${JSON.stringify(fontFamily)},`)
}

function keepValidPreview(
  preview: KernelSessionPreview | null,
  state: KernelState
): KernelSessionPreview | null {
  if (
    preview === null ||
    preview.projectKey !== state.activeProjectKey ||
    preview.sessionKey === state.activeSessionKey ||
    !state.sessions.some(({ key }) => key === preview.sessionKey)
  ) {
    return null
  }
  return preview
}

function keepValidSessionViewTarget(
  target: SessionViewTarget | null,
  state: KernelState
): SessionViewTarget | null {
  if (target === null || target.projectKey !== state.activeProjectKey) return null
  if (target.kind === 'session') {
    if (target.sessionKey === state.activeSessionKey) return null
    return state.sessions.some(({ key }) => key === target.sessionKey) ? target : null
  }
  if (state.activeSessionKey === null) {
    return target.sawProvisional ? target : { ...target, sawProvisional: true }
  }
  return target.sawProvisional ? null : target
}

function applyStatePatches(state: KernelState, patches: KernelStatePatch[]): KernelState {
  let runtime = state.runtime
  let session = state.session
  let entries = state.conversation.entries
  let activeRunStartIndex = state.conversation.activeRunStartIndex
  let conversationChanged = false
  let entriesCopied = false

  for (const patch of patches) {
    if (patch.runtime !== undefined) runtime = patch.runtime
    if (patch.session !== undefined) session = patch.session
    if (patch.conversation === undefined) continue
    if (patch.conversation.entries !== undefined) {
      if (!entriesCopied) {
        entries = entries.slice()
        entriesCopied = true
      }
      conversationChanged = true
      for (const change of patch.conversation.entries) {
        if (change.type === 'insert') {
          if (change.index === entries.length) entries.push(change.entry)
          else if (entries[change.index]?.id !== change.entry.id) {
            throw new Error(`Conversation insert index ${change.index} is out of sequence.`)
          }
          continue
        }

        const current = entries[change.index]
        if (current === undefined) {
          throw new Error(`Conversation patch index ${change.index} does not exist.`)
        }
        if (change.type === 'append-message-text') {
          if (current.kind !== 'message') throw new Error('Conversation message patch kind mismatch.')
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = {
            ...current,
            text,
            streaming: change.streaming,
            stopReason: change.stopReason,
            error: change.error
          }
          continue
        }
        if (change.type === 'append-thinking-text') {
          if (current.kind !== 'thinking') throw new Error('Conversation thinking patch kind mismatch.')
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = { ...current, text, streaming: change.streaming }
          continue
        }
        if (current.kind !== 'tool') throw new Error('Conversation tool patch kind mismatch.')
        const output = appendProjectedText(current.output, change.from, change.output)
        if (output === null) continue
        entries[change.index] = {
          ...current,
          output,
          status: change.status,
          details: change.details,
          truncated: change.truncated,
          durationMs: change.durationMs
        }
      }
    }
    if ('activeRunStartIndex' in patch.conversation) {
      activeRunStartIndex = patch.conversation.activeRunStartIndex ?? null
      conversationChanged = true
    }
  }

  return {
    ...state,
    runtime,
    session,
    conversation: conversationChanged
      ? { entries, activeRunStartIndex }
      : state.conversation
  }
}

function appendProjectedText(current: string, from: number, addition: string): string | null {
  if (current.length === from) return `${current}${addition}`
  const targetLength = from + addition.length
  if (current.length >= targetLength && current.slice(from, targetLength) === addition) return null
  throw new Error(`Conversation text patch expected ${from} characters; received ${current.length}.`)
}
