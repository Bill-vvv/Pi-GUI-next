import { useCallback, useMemo, useRef } from 'react'

import type {
  KernelAskAnswer,
  KernelState,
  ThinkingLevel
} from '../shared/kernel-contract.ts'
import { IconButton } from '../renderer/src/components/IconButton.tsx'
import { Timeline } from '../renderer/src/features/chat/Timeline.tsx'
import {
  basename,
  sessionTitle
} from '../renderer/src/features/project/ProjectNavigator.tsx'
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
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetOpenAiFastMode: (enabled: boolean) => Promise<void>
  onLogout: () => Promise<void>
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
  onSetModel,
  onSetThinkingLevel,
  onSetOpenAiFastMode,
  onLogout,
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
          <button type="button" onClick={onReconnect}>
            重新连接
          </button>
        </div>
      ) : null}
      <header className="remote-topbar">
        <div className="remote-topbar-row">
          <span
            className={`remote-connection remote-connection-${connectionStatus}`}
            role="status"
            aria-live="polite"
          >
            {connectionLabel}
          </span>
          <div className="remote-topbar-actions">
            <button
              type="button"
              className="remote-text-button"
              disabled={busy}
              onClick={() => {
                void onLogout()
              }}
            >
              退出
            </button>
          </div>
        </div>

        <div className="remote-topbar-row remote-selectors">
          <label className="remote-select-field">
            <span className="visually-hidden">项目</span>
            <select
              aria-label="选择项目"
              disabled={!connected || busy || userProjects.length === 0}
              value={activeProject?.path ?? ''}
              onChange={(event) => {
                const value = event.target.value
                if (!value) return
                void onActivateProject(value)
              }}
            >
              {activeProject === null ? <option value="">选择项目</option> : null}
              {userProjects.map((project) => (
                <option key={project.path} value={project.path}>
                  {basename(project.path) ?? project.path}
                </option>
              ))}
            </select>
          </label>

          <label className="remote-select-field">
            <span className="visually-hidden">会话</span>
            <select
              aria-label="选择会话"
              disabled={!connected || busy || activeProject === null || sessions.length === 0}
              value={activeSession?.key ?? ''}
              onChange={(event) => {
                const value = event.target.value
                if (!value) return
                void onActivateSession(value)
              }}
            >
              {activeSession === null ? <option value="">选择会话</option> : null}
              {sessions.map((session) => (
                <option key={session.key} value={session.key}>
                  {sessionTitle(session)}
                </option>
              ))}
            </select>
          </label>

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

        <div className="remote-topbar-meta" aria-live="polite">
          <span>{basename(activeProject?.path ?? null) ?? '未选择项目'}</span>
          <span aria-hidden="true">·</span>
          <span>{activeSession ? sessionTitle(activeSession) : '未选择会话'}</span>
          <span aria-hidden="true">·</span>
          <span>{runtimeStatusLabel(runtimeStatus)}</span>
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
            onForkTurn={() => undefined}
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
    </div>
  )
}

function runtimeStatusLabel(status: KernelState['runtime']['status']): string {
  switch (status) {
    case 'ready':
      return '就绪'
    case 'running':
      return '运行中'
    case 'starting':
      return '启动中'
    case 'stopping':
      return '停止中'
    case 'stopped':
      return '已停止'
    case 'crashed':
      return '已崩溃'
    default:
      return status
  }
}
