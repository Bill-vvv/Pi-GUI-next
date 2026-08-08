import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

import type {
  KernelAskAnswer,
  KernelConversationPageRequest,
  KernelMutationAck,
  KernelState,
  ThinkingLevel
} from '../shared/kernel-contract.ts'
import {
  REMOTE_PAIRING_CODE_LENGTH,
  REMOTE_PROTOCOL_VERSION
} from '../shared/remote-contract.ts'
import { awaitMutationAck as awaitKernelMutationAck } from '../renderer/src/kernel/await-mutation-ack.ts'
import {
  DEFAULT_RESYNC_TIMEOUT_MS,
  KernelRevisionBarrier
} from '../renderer/src/kernel/kernel-revision-barrier.ts'
import { applyStatePatches } from '../renderer/src/kernel/kernel-state-patches.ts'
import { unknownErrorMessage } from '../renderer/src/unknown-error-message.ts'
import {
  isCompletePairingCode,
  normalizePairingCodeInput
} from './pairing-code.ts'
import {
  RemoteShell,
  type RemoteConnectionStatus
} from './RemoteShell.tsx'
import {
  parseKernelConversationPage,
  parseKernelMessageImage,
  parseKernelMutationAck,
  RemoteClient,
  RemoteTransportError,
  type RemoteSessionStatus
} from './transport.ts'

type RemoteAppProps = {
  client: RemoteClient
}

export function RemoteApp({ client }: RemoteAppProps): React.JSX.Element {
  const [sessionStatus, setSessionStatus] = useState<RemoteSessionStatus | null>(null)
  const [authChecking, setAuthChecking] = useState(true)
  const [pairingCode, setPairingCode] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [kernelState, setKernelState] = useState<KernelState | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<RemoteConnectionStatus>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [connectionAttempt, setConnectionAttempt] = useState(0)

  const kernelStateRef = useRef<KernelState | null>(null)
  const revisionBarrierRef = useRef<KernelRevisionBarrier | null>(null)
  const busyRef = useRef(false)

  useEffect(() => client.onUnauthorized((error) => {
    setLoginError(`远程会话已失效：${error.message}`)
    setSessionStatus({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: false
    })
    setKernelState(null)
    kernelStateRef.current = null
  }), [client])

  useEffect(() => {
    let active = true
    setAuthChecking(true)
    void client.getSession().then(
      (status) => {
        if (!active) return
        setSessionStatus(status)
        setAuthChecking(false)
      },
      (error: unknown) => {
        if (!active) return
        setLoginError(unknownErrorMessage(error))
        setSessionStatus({
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          authenticated: false
        })
        setAuthChecking(false)
      }
    )
    return () => {
      active = false
    }
  }, [client])

  useEffect(() => {
    if (sessionStatus?.authenticated !== true) {
      setKernelState(null)
      kernelStateRef.current = null
      setConnectionStatus('disconnected')
      return
    }

    let active = true
    let unsubscribe = (): void => undefined
    setConnectionStatus('connecting')
    setConnectionError(null)
    setActionError(null)

    const failConnection = (error: unknown): void => {
      if (!active) return
      unsubscribe()
      const message = unknownErrorMessage(error)
      if (error instanceof RemoteTransportError && error.status === 401) {
        setLoginError(`远程会话已失效：${message}`)
        setSessionStatus({
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          authenticated: false
        })
        return
      }
      setConnectionError(message)
      setConnectionStatus('disconnected')
    }

    const barrier = new KernelRevisionBarrier({
      applyState: (state) => {
        if (!active) return
        kernelStateRef.current = state
        setKernelState(state)
      },
      applyPatches: (state, patches) =>
        applyStatePatches(state, patches.map((entry) => entry.patch)),
      fetchSnapshot: () => client.getState(),
      scheduleFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle as number),
      onRecoveryError: failConnection
    })
    revisionBarrierRef.current = barrier

    unsubscribe = client.subscribe(
      (event) => {
        if (!active) return
        try {
          barrier.handleEvent(event)
          setConnectionStatus('connected')
          setConnectionError(null)
        } catch (error) {
          failConnection(error)
        }
      },
      failConnection
    )

    void (async () => {
      let timeoutHandle: number | null = null
      try {
        const snapshot = await Promise.race([
          client.getState(),
          new Promise<never>((_, reject) => {
            timeoutHandle = window.setTimeout(() => {
              reject(new Error(`Kernel snapshot timed out after ${DEFAULT_RESYNC_TIMEOUT_MS}ms.`))
            }, DEFAULT_RESYNC_TIMEOUT_MS)
          })
        ])
        if (!active) return
        barrier.handleSnapshot(snapshot)
        setConnectionStatus('connected')
        setConnectionError(null)
      } catch (error) {
        failConnection(error)
      } finally {
        if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
      }
    })()

    return () => {
      active = false
      if (revisionBarrierRef.current === barrier) revisionBarrierRef.current = null
      barrier.dispose()
      unsubscribe()
    }
  }, [client, sessionStatus?.authenticated, connectionAttempt])

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
    const root = document.documentElement
    root.dataset.accent = kernelState?.appearance.accentColor ?? 'amber'
    root.style.setProperty(
      '--surface-transparency',
      `${kernelState?.appearance.surfaceTransparency ?? 20}%`
    )
  }, [kernelState?.appearance.accentColor, kernelState?.appearance.surfaceTransparency])

  useEffect(() => {
    const rootStyle = document.documentElement.style
    const textSize = kernelState?.appearance.textSize ?? 'default'
    rootStyle.setProperty(
      '--text-root',
      textSize === 'small' ? '14px' : textSize === 'large' ? '16px' : '15px'
    )
  }, [kernelState?.appearance.textSize])

  useEffect(() => {
    const viewport = window.visualViewport
    if (viewport == null) return
    const updateKeyboardInset = (): void => {
      const current = window.visualViewport
      if (current == null) return
      const inset = Math.max(0, window.innerHeight - current.height - current.offsetTop)
      document.documentElement.style.setProperty('--remote-keyboard-inset', `${inset}px`)
    }
    updateKeyboardInset()
    viewport.addEventListener('resize', updateKeyboardInset)
    viewport.addEventListener('scroll', updateKeyboardInset)
    return () => {
      viewport.removeEventListener('resize', updateKeyboardInset)
      viewport.removeEventListener('scroll', updateKeyboardInset)
      document.documentElement.style.removeProperty('--remote-keyboard-inset')
    }
  }, [])

  async function awaitMutationAck(operation: () => Promise<KernelMutationAck>): Promise<KernelMutationAck> {
    return awaitKernelMutationAck(operation, revisionBarrierRef.current)
  }

  async function runMutation(operation: () => Promise<KernelMutationAck>): Promise<void> {
    if (busyRef.current) throw new Error('Another action is already running.')
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    try {
      await awaitMutationAck(operation)
    } catch (error) {
      setActionError(unknownErrorMessage(error))
      throw error
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const mutate = useCallback(async (command: Parameters<RemoteClient['command']>[0]) => {
    const value = await client.command(command)
    return parseKernelMutationAck(value)
  }, [client])

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const code = normalizePairingCodeInput(pairingCode)
    if (!isCompletePairingCode(code) || loginBusy) return
    setLoginBusy(true)
    setLoginError(null)
    try {
      const status = await client.pair(code)
      setSessionStatus(status)
      setPairingCode('')
      if (!status.authenticated) {
        throw new Error('Pairing succeeded without an authenticated session.')
      }
    } catch (error) {
      setLoginError(unknownErrorMessage(error))
      setSessionStatus({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        authenticated: false
      })
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleLogout(): Promise<void> {
    setActionError(null)
    try {
      await client.logout()
    } catch (error) {
      setActionError(`退出失败，已配对手机可能仍然有效：${unknownErrorMessage(error)}`)
      return
    }
    setSessionStatus({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: false
    })
    setKernelState(null)
    kernelStateRef.current = null
  }

  async function loadEarlierConversation(): Promise<void> {
    const state = kernelStateRef.current
    const firstEntry = state?.conversation.entries[0]
    if (
      state === null ||
      state.activeProjectKey === null ||
      state.activeSessionKey === null ||
      state.session.id === null ||
      state.conversation.startIndex <= 0 ||
      firstEntry === undefined
    ) {
      throw new Error('当前对话没有可加载的更早历史。')
    }
    const request: KernelConversationPageRequest = {
      projectKey: state.activeProjectKey,
      sessionKey: state.activeSessionKey,
      sessionId: state.session.id,
      beforeIndex: state.conversation.startIndex,
      beforeEntryId: firstEntry.id
    }
    const page = parseKernelConversationPage(await client.command({
      type: 'kernel.load-earlier-conversation',
      request
    }))
    const barrier = revisionBarrierRef.current
    const current = barrier?.getState() ?? null
    if (
      current === null ||
      current.activeProjectKey !== request.projectKey ||
      current.activeSessionKey !== request.sessionKey ||
      current.session.id !== request.sessionId
    ) {
      throw new Error('Conversation page response is stale after a Session switch.')
    }
    barrier!.mergeConversationPage(page)
  }

  if (authChecking) {
    return <main className="screen-loading">正在检查远程会话…</main>
  }

  if (sessionStatus?.authenticated !== true) {
    const completeCode = isCompletePairingCode(pairingCode)
    return (
      <main className="remote-login">
        <form className="remote-login-card" onSubmit={(event) => { void handleLogin(event) }}>
          <h1 className="remote-login-title">Pi GUI Remote</h1>
          <p className="remote-login-copy">输入桌面端生成的 6 位配对码，连接同一主机上的 Pi GUI 远程端点。</p>
          <label className="remote-login-field" htmlFor="remote-pairing-code">
            <span>6 位配对码</span>
            <input
              id="remote-pairing-code"
              className="remote-pairing-code-input"
              type="text"
              name="pairing-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern={`[0-9]{${REMOTE_PAIRING_CODE_LENGTH}}`}
              maxLength={REMOTE_PAIRING_CODE_LENGTH}
              value={pairingCode}
              disabled={loginBusy}
              aria-invalid={loginError !== null}
              aria-describedby={loginError === null ? undefined : 'remote-pairing-error'}
              onChange={(event) => setPairingCode(normalizePairingCodeInput(event.target.value))}
              required
            />
          </label>
          {loginError !== null ? (
            <p id="remote-pairing-error" className="remote-action-error" role="alert">{loginError}</p>
          ) : null}
          <button className="remote-login-submit" type="submit" disabled={loginBusy || !completeCode}>
            {loginBusy ? '配对中…' : '配对'}
          </button>
        </form>
      </main>
    )
  }

  if (kernelState === null) {
    return (
      <main className={`screen-loading${connectionError !== null ? ' error' : ''}`}>
        {connectionError !== null ? (
          <div className="kernel-connection-error" role="alert">
            <span>{connectionError}</span>
            <button type="button" onClick={() => setConnectionAttempt((value) => value + 1)}>
              重试
            </button>
          </div>
        ) : (
          '正在同步远程状态…'
        )}
      </main>
    )
  }

  return (
    <RemoteShell
        state={kernelState}
        connectionStatus={connectionStatus}
        connectionError={connectionError}
        actionError={actionError}
        busy={busy}
        onActivateProject={async (projectKey) => {
          await runMutation(() => mutate({ type: 'kernel.activate-project', projectKey }))
        }}
        onActivateSession={async (sessionKey) => {
          await runMutation(() => mutate({ type: 'kernel.activate-session', sessionKey }))
        }}
        onStartSession={async () => {
          await runMutation(() => mutate({ type: 'kernel.start-session' }))
        }}
        onReloadSession={async () => {
          await runMutation(() => mutate({ type: 'kernel.reload-session' }))
        }}
        onLoadEarlierConversation={async () => {
          setActionError(null)
          try {
            await loadEarlierConversation()
          } catch (error) {
            setActionError(unknownErrorMessage(error))
            throw error
          }
        }}
        onPrompt={async (message) => {
          const expectedSessionKey = kernelStateRef.current?.activeSessionKey
          if (expectedSessionKey === null || expectedSessionKey === undefined) {
            throw new Error('Remote prompt requires an active session key.')
          }
          await runMutation(() => mutate({
            type: 'kernel.prompt',
            message,
            expectedSessionKey
          }))
        }}
        onSteer={async (message) => {
          await runMutation(() => mutate({ type: 'kernel.steer', message }))
        }}
        onFollowUp={async (message) => {
          await runMutation(() => mutate({ type: 'kernel.follow-up', message }))
        }}
        onAbort={async () => {
          // Abort should not be blocked by exclusive busy state in the same way, but still fail-fast once.
          setActionError(null)
          try {
            await awaitMutationAck(() => mutate({ type: 'kernel.abort' }))
          } catch (error) {
            setActionError(unknownErrorMessage(error))
            throw error
          }
        }}
        onSubmitAsk={async (sessionKey, toolCallId, answers: KernelAskAnswer[]) => {
          await runMutation(() => mutate({
            type: 'kernel.submit-ask',
            sessionKey,
            toolCallId,
            answers
          }))
        }}
        onCancelAsk={async (sessionKey, toolCallId) => {
          await runMutation(() => mutate({
            type: 'kernel.cancel-ask',
            sessionKey,
            toolCallId
          }))
        }}
        onSetModel={async (provider, modelId) => {
          await runMutation(() => mutate({ type: 'kernel.set-model', provider, modelId }))
        }}
        onSetThinkingLevel={async (level: ThinkingLevel) => {
          await runMutation(() => mutate({ type: 'kernel.set-thinking-level', level }))
        }}
        onSetOpenAiFastMode={async (enabled) => {
          await runMutation(() => mutate({ type: 'kernel.set-openai-fast-mode', enabled }))
        }}
        onLogout={handleLogout}
        onReconnect={() => setConnectionAttempt((value) => value + 1)}
    />
  )
}

export function createRemoteImageLoaders(client: RemoteClient) {
  return {
    getMessageImage: async (
      sessionKey: string,
      messageId: string,
      attachmentIndex: number
    ) => parseKernelMessageImage(await client.command({
      type: 'kernel.get-message-image',
      sessionKey,
      messageId,
      attachmentIndex
    })),
    getToolImage: async (
      sessionKey: string,
      toolCallId: string,
      contentIndex: number
    ) => parseKernelMessageImage(await client.command({
      type: 'kernel.get-tool-image',
      sessionKey,
      toolCallId,
      contentIndex
    }))
  }
}
