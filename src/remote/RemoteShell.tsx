import { useCallback, useMemo, useRef } from 'react'

import type {
  KernelAskAnswer,
  KernelExtensionDialogRequest,
  KernelProjectState,
  KernelSessionSummary,
  KernelState,
  ThinkingLevel
} from '../shared/kernel-contract.ts'
import { IconButton } from '../renderer/src/components/IconButton.tsx'
import {
  Select,
  type SelectOption,
  type SelectOptionDetailTone,
  type SelectOptionGroup
} from '../renderer/src/components/Select.tsx'
import { Timeline } from '../renderer/src/features/chat/Timeline.tsx'
import { ExtensionDialog } from '../renderer/src/features/extensions/ExtensionDialog.tsx'
import {
  basename,
  sessionTitle
} from '../renderer/src/features/project/ProjectNavigator.tsx'
import { formatSessionActivityAge } from '../renderer/src/features/project/session-activity-time.ts'
import { timelineConversation } from '../renderer/src/composition/conversation-presentation.ts'
import { DEFAULT_TOOL_DISPLAY_DENSITY } from '../renderer/src/tool-display-density.ts'
import { RemoteComposer } from './RemoteComposer.tsx'

export type RemoteConnectionStatus = 'connecting' | 'connected' | 'disconnected'

type RemoteShellProps = {
  state: KernelState
  connectionStatus: RemoteConnectionStatus
  connectionError: string | null
  actionError: string | null
  busy: boolean
  onActivateProject: (projectKey: string) => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onReloadSession: () => Promise<void>
  onLoadEarlierConversation: () => Promise<void>
  onPrompt: (message: string) => Promise<void>
  onSteer: (message: string) => Promise<void>
  onFollowUp: (message: string) => Promise<void>
  onAbort: () => Promise<void>
  onSubmitAsk: (sessionKey: string, toolCallId: string, answers: KernelAskAnswer[]) => Promise<void>
  onCancelAsk: (sessionKey: string, toolCallId: string) => Promise<void>
  onRespondExtensionDialog: (
    request: KernelExtensionDialogRequest,
    value: string
  ) => Promise<void>
  onCancelExtensionDialog: (request: KernelExtensionDialogRequest) => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetOpenAiFastMode: (enabled: boolean) => Promise<void>
  onReconnect: () => void
}

export function RemoteShell({
  state,
  connectionStatus,
  connectionError,
  actionError,
  busy,
  onActivateProject,
  onActivateSession,
  onStartSession,
  onReloadSession,
  onLoadEarlierConversation,
  onPrompt,
  onSteer,
  onFollowUp,
  onAbort,
  onSubmitAsk,
  onCancelAsk,
  onRespondExtensionDialog,
  onCancelExtensionDialog,
  onSetModel,
  onSetThinkingLevel,
  onSetOpenAiFastMode,
  onReconnect
}: RemoteShellProps): React.JSX.Element {
  const mainChatRef = useRef<HTMLElement>(null)
  const userProjects = useMemo(
    () => state.projects.filter((project) => project.workspaceKind !== 'task'),
    [state.projects]
  )
  const activeProject = userProjects.find((project) => project.path === state.activeProjectKey) ?? null
  const sessions = activeProject === null ? [] : state.sessions
  const activeSession = sessions.find((session) => session.key === state.activeSessionKey) ?? null
  const projectOptions = projectSelectOptions(userProjects, state.activeProjectKey, sessions)
  const sessionGroups = sessionSelectGroups(sessions, Date.now())
  const timeline = activeProject === null ? null : timelineConversation(state.conversation)
  const runtimeStatus = state.runtime.status
  const connected = connectionStatus === 'connected'
  const canReload = runtimeStatus === 'crashed' || runtimeStatus === 'stopped'
  const hasEarlierConversation =
    activeProject !== null &&
    state.activeSessionKey !== null &&
    state.session.id !== null &&
    state.conversation.startIndex > 0
  const connectionLabel =
    connectionStatus === 'connected'
      ? '已连接'
      : connectionStatus === 'connecting'
        ? '连接中'
        : '已断开'

  const handleComposerMeasuredHeightChange = useCallback((height: number) => {
    const mainChat = mainChatRef.current
    if (mainChat === null) return
    if (height > 0) {
      mainChat.style.setProperty('--composer-measured-clearance', `${height}px`)
    } else {
      mainChat.style.removeProperty('--composer-measured-clearance')
    }
  }, [])

  return (
    <div className="remote-shell">
      {connectionError !== null && !connected ? (
        <div className="remote-connection-banner" role="alert">
          <span>{connectionError}</span>
          {connectionStatus === 'disconnected' ? (
            <button type="button" onClick={onReconnect}>
              重新连接
            </button>
          ) : null}
        </div>
      ) : null}
      <header className="remote-topbar">
        <div className="remote-project-row">
          <div className="remote-select-field">
            <label className="visually-hidden" htmlFor="remote-project-select">项目</label>
            <Select
              id="remote-project-select"
              disabled={!connected || busy || userProjects.length === 0}
              value={activeProject?.path ?? ''}
              groups={[{ options: projectOptions }]}
              onValueChange={(value) => {
                if (!value) return
                void onActivateProject(value)
              }}
            />
          </div>
          <span
            className={`remote-connection remote-connection-${connectionStatus}`}
            role="status"
            aria-live="polite"
          >
            {connectionLabel}
          </span>
        </div>

        <div className="remote-session-row">
          <div className="remote-select-field">
            <label className="visually-hidden" htmlFor="remote-session-select">会话</label>
            <Select
              id="remote-session-select"
              disabled={!connected || busy || activeProject === null || sessions.length === 0}
              value={activeSession?.key ?? ''}
              groups={sessionGroups}
              onValueChange={(value) => {
                if (!value) return
                void onActivateSession(value)
              }}
            />
          </div>

          <IconButton
            className="remote-icon-action"
            icon="plus"
            label="新建会话"
            disabled={!connected || busy || activeProject === null}
            onClick={() => {
              void onStartSession()
            }}
          />
          {canReload ? (
            <button
              type="button"
              className="remote-text-button"
              disabled={!connected || busy || activeSession === null}
              onClick={() => {
                void onReloadSession()
              }}
            >
              重载
            </button>
          ) : null}
        </div>

        {actionError !== null ? (
          <p className="remote-action-error" role="alert">{actionError}</p>
        ) : null}
      </header>

      <main ref={mainChatRef} className="remote-main-chat main-chat">
        {timeline === null ? (
          <section className="remote-workspace-unavailable" role="status">
            <strong>远程端不操作 Task 工作区</strong>
            <span>请从上方选择一个 Project；本地 Task 保持由桌面端控制。</span>
          </section>
        ) : (
          <Timeline
            key={`${state.activeProjectKey ?? ''}:${state.activeSessionKey ?? ''}:${state.session.id ?? ''}`}
            entries={timeline.entries}
            activeRunStartIndex={timeline.activeRunStartIndex}
            runtimeStatus={runtimeStatus}
            loading={false}
            compactionActive={state.session.compaction !== null}
            navigateToLatestPromptOnMount={state.activeSessionKey !== null}
            showPromptNavigation={false}
            toolDisplayDensity={DEFAULT_TOOL_DISPLAY_DENSITY}
            sessionKey={state.activeSessionKey}
            askSessionKey={state.activeSessionKey}
            canCopyAnswers={false}
            canExportSession={false}
            canForkSession={false}
            canEditHistoryPrompt={false}
            hasEarlierConversation={hasEarlierConversation}
            conversationActionBusy={!connected || busy}
            conversationActionStatus={null}
            conversationActionError={null}
            onCopyAnswer={async () => {
              throw new Error('Remote does not support copy answer.')
            }}
            onExportSession={async () => {
              throw new Error('Remote does not support export.')
            }}
            onLoadEarlierConversation={onLoadEarlierConversation}
            onForkTurn={async () => undefined}
            onNavigateHistoryPrompt={async () => {
              throw new Error('Remote does not support history prompt edit.')
            }}
            onSendHistoryPrompt={async () => {
              throw new Error('Remote does not support history prompt send.')
            }}
            onHistoryPromptEditingChange={() => undefined}
            subagentTaskSelection={null}
            onOpenSubagentTask={() => undefined}
            onSubmitAsk={onSubmitAsk}
            onCancelAsk={onCancelAsk}
            onLayoutStabilizeReady={() => undefined}
            warning={state.runtime.lastError}
          />
        )}

        <RemoteComposer
          state={state}
          workspaceAvailable={activeProject !== null}
          connected={connected}
          busy={busy}
          onPrompt={onPrompt}
          onSteer={onSteer}
          onFollowUp={onFollowUp}
          onAbort={onAbort}
          onSetModel={onSetModel}
          onSetThinkingLevel={onSetThinkingLevel}
          onSetOpenAiFastMode={onSetOpenAiFastMode}
          onMeasuredHeightChange={handleComposerMeasuredHeightChange}
        />
      </main>

      {state.extensionDialog === null || state.extensionDialog === undefined ? null : (
        <ExtensionDialog
          key={[
            state.extensionDialog.projectKey,
            state.extensionDialog.sessionKey,
            state.extensionDialog.sessionId,
            state.extensionDialog.commandInvocationId,
            state.extensionDialog.requestId
          ].join('\u0000')}
          request={state.extensionDialog}
          onRespond={onRespondExtensionDialog}
          onCancel={onCancelExtensionDialog}
        />
      )}
    </div>
  )
}

type SelectDetail = {
  text: string
  tone: SelectOptionDetailTone
}

function projectSelectOptions(
  projects: readonly KernelProjectState[],
  activeProjectKey: string | null,
  activeSessions: readonly KernelSessionSummary[]
): SelectOption[] {
  return projects.map((project) => {
    const sessions = project.path === activeProjectKey
      ? activeSessions
      : project.sessions ?? []
    const awaitingCount = sessions.filter((session) => session.awaitingUserInput).length
    const observedBusyCount = sessions.filter((session) => isSessionBusy(session.runtimeStatus)).length
    const busyCount = Math.max(project.busySessionCount ?? 0, observedBusyCount)
    const processingCount = Math.max(0, busyCount - awaitingCount)
    const details: string[] = []
    if (awaitingCount > 0) details.push(`${awaitingCount} 待回复`)
    if (processingCount > 0) details.push(`${processingCount} 处理中`)

    return {
      value: project.path,
      label: basename(project.path) ?? project.path,
      detail: details.length === 0 ? undefined : details.join(' · '),
      detailTone: awaitingCount > 0 ? 'attention' : 'active'
    }
  })
}

function sessionSelectGroups(
  sessions: readonly KernelSessionSummary[],
  now: number
): SelectOptionGroup[] {
  const attention: SelectOption[] = []
  const active: SelectOption[] = []
  const history: SelectOption[] = []

  for (const session of sessions) {
    const detail = sessionSelectDetail(session, now)
    const option: SelectOption = {
      value: session.key,
      label: sessionTitle(session),
      detail: detail.text,
      detailTone: detail.tone
    }
    if (sessionNeedsAttention(session)) attention.push(option)
    else if (isSessionBusy(session.runtimeStatus)) active.push(option)
    else history.push(option)
  }

  return [
    { label: '需要处理', options: attention },
    { label: '进行中', options: active },
    { label: '其他会话', options: history }
  ].filter((group) => group.options.length > 0)
}

function sessionSelectDetail(session: KernelSessionSummary, now: number): SelectDetail {
  if (session.awaitingUserInput) return { text: '等待你回复', tone: 'attention' }
  if (session.requiresReload === true) return { text: '需要重载', tone: 'attention' }

  switch (session.runtimeStatus) {
    case 'running':
      return { text: '正在处理', tone: 'active' }
    case 'starting':
      return { text: '正在启动', tone: 'active' }
    case 'stopping':
      return { text: '正在收尾', tone: 'active' }
    case 'crashed':
      return { text: '已中断', tone: 'error' }
    case 'ready':
      return { text: '空闲', tone: 'default' }
    case 'stopped': {
      const age = formatSessionActivityAge(session.lastActivityAt, now)
      return { text: age === null ? '已停止' : age === '刚刚' ? age : `${age}前`, tone: 'default' }
    }
    default:
      return { text: session.runtimeStatus, tone: 'default' }
  }
}

function sessionNeedsAttention(session: KernelSessionSummary): boolean {
  return session.awaitingUserInput ||
    session.requiresReload === true ||
    session.runtimeStatus === 'crashed'
}

function isSessionBusy(status: KernelSessionSummary['runtimeStatus']): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping'
}
