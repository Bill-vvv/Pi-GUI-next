import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelModelPricingFetchResult,
  KernelProviderAuthEvent,
  KernelProviderAuthMethod,
  KernelProviderAuthNotice,
  KernelProviderAuthPrompt,
  KernelProviderAuthType,
  KernelProviderConfig,
  KernelProviderCredential,
  KernelProviderInput,
  KernelProviderTestResult
} from '../../../../shared/kernel-contract'
import { ProviderSettings } from './ProviderSettings'
import './credentials-panel.css'

type CredentialsPanelProps = {
  busy: boolean
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
  onOpenExternal: (url: string) => Promise<void>
  onListProviders: () => Promise<KernelProviderConfig[]>
  onSaveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  onRemoveProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  onTestProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
  onFetchModelPricing: (
    providerId: string,
    modelIds: string[]
  ) => Promise<KernelModelPricingFetchResult>
}

type AuthOperation = {
  operationId: string | null
  providerId: string
  authType: KernelProviderAuthType
  cancelling: boolean
}

type AuthPromptState = {
  operationId: string
  promptId: string
  providerId: string
  prompt: KernelProviderAuthPrompt
  submitting: boolean
}

type AuthNoticeState = {
  operationId: string
  providerId: string
  notice: KernelProviderAuthNotice
}

export function CredentialsPanel({
  busy,
  onListProviderCredentials,
  onLoginProvider,
  onSubmitProviderAuthPrompt,
  onCancelProviderLogin,
  onLogoutProvider,
  onSubscribeProviderAuth,
  onOpenExternal,
  onListProviders,
  onSaveProvider,
  onRemoveProvider,
  onTestProvider,
  onFetchModelPricing
}: CredentialsPanelProps): React.JSX.Element {
  const [credentials, setCredentials] = useState<KernelProviderCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [operation, setOperation] = useState<AuthOperation | null>(null)
  const [promptState, setPromptState] = useState<AuthPromptState | null>(null)
  const [noticeState, setNoticeState] = useState<AuthNoticeState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const operationRef = useRef<AuthOperation | null>(null)
  const promptRef = useRef<AuthPromptState | null>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)
  const promptOptionsRef = useRef<HTMLDivElement>(null)
  const cancelRequestedRef = useRef(false)

  function updateOperation(next: AuthOperation | null): void {
    operationRef.current = next
    setOperation(next)
  }

  function updatePrompt(next: AuthPromptState | null): void {
    promptRef.current = next
    setPromptState(next)
  }

  function clearTransientInput(): void {
    setPromptValue('')
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      const activeOperationId = operationRef.current?.operationId
      if (activeOperationId !== null && activeOperationId !== undefined) {
        void onCancelProviderLogin(activeOperationId).catch(() => undefined)
      }
      mountedRef.current = false
      operationRef.current = null
      promptRef.current = null
      cancelRequestedRef.current = false
    }
  }, [onCancelProviderLogin])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void onListProviderCredentials()
      .then((nextCredentials) => {
        if (active) setCredentials(nextCredentials)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, '无法读取 Provider 凭证状态。'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onListProviderCredentials])

  useEffect(() => onSubscribeProviderAuth((event) => {
    const current = operationRef.current
    if (event.type === 'provider-auth.started') {
      if (
        current === null ||
        current.operationId !== null ||
        current.providerId !== event.providerId ||
        current.authType !== event.authType
      ) return
      updateOperation({ ...current, operationId: event.operationId })
      setStatus(`正在登录 ${event.providerId}…`)
      return
    }
    if (
      current?.operationId !== event.operationId ||
      current.providerId !== event.providerId
    ) return
    if (event.type === 'provider-auth.prompt') {
      clearTransientInput()
      updatePrompt({
        operationId: event.operationId,
        promptId: event.promptId,
        providerId: event.providerId,
        prompt: event.prompt,
        submitting: false
      })
      return
    }
    setNoticeState({
      operationId: event.operationId,
      providerId: event.providerId,
      notice: event.notice
    })
  }), [onSubscribeProviderAuth])

  useEffect(() => {
    if (promptState === null) return
    if (promptState.prompt.type === 'select') {
      promptOptionsRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    } else {
      promptInputRef.current?.focus()
    }
  }, [promptState?.promptId])

  const controlsDisabled = busy || loading || action !== null || operation !== null
  const configuredCredentials = credentials.filter((credential) => credential.configured)

  async function login(
    credential: KernelProviderCredential,
    method: KernelProviderAuthMethod
  ): Promise<void> {
    if (controlsDisabled) return
    const pendingOperation: AuthOperation = {
      operationId: null,
      providerId: credential.providerId,
      authType: method.type,
      cancelling: false
    }
    cancelRequestedRef.current = false
    updateOperation(pendingOperation)
    updatePrompt(null)
    setNoticeState(null)
    clearTransientInput()
    setError(null)
    setStatus(`正在准备 ${methodLabel(method)}…`)
    try {
      const nextCredentials = await onLoginProvider(credential.providerId, method.type)
      if (!mountedRef.current) return
      setCredentials(nextCredentials)
      setStatus(cancelRequestedRef.current ? '登录已取消。' : `${credential.providerName} 登录完成。`)
    } catch (reason) {
      if (!mountedRef.current) return
      if (!cancelRequestedRef.current) {
        setError(errorMessage(reason, `${credential.providerName} 登录失败。`))
        setStatus(null)
      }
    } finally {
      if (mountedRef.current) {
        clearTransientInput()
        updatePrompt(null)
        setNoticeState(null)
        updateOperation(null)
      }
      cancelRequestedRef.current = false
    }
  }

  async function logout(credential: KernelProviderCredential): Promise<void> {
    if (controlsDisabled || credential.storedCredentialType === null) return
    setAction(`logout:${credential.providerId}`)
    setError(null)
    setStatus(`正在退出 ${credential.providerName}…`)
    try {
      const nextCredentials = await onLogoutProvider(credential.providerId)
      if (!mountedRef.current) return
      setCredentials(nextCredentials)
      setStatus(`${credential.providerName} 已退出。`)
    } catch (reason) {
      if (!mountedRef.current) return
      setError(errorMessage(reason, `${credential.providerName} 退出失败。`))
      setStatus(null)
    } finally {
      if (mountedRef.current) setAction(null)
    }
  }

  async function submitPrompt(value: string): Promise<void> {
    const current = promptRef.current
    const activeOperation = operationRef.current
    if (
      current === null ||
      current.submitting ||
      activeOperation?.operationId !== current.operationId ||
      activeOperation.providerId !== current.providerId
    ) return
    if (
      current.prompt.type === 'select' &&
      !current.prompt.options.some((option) => option.id === value)
    ) return
    const submitting = { ...current, submitting: true }
    updatePrompt(submitting)
    clearTransientInput()
    setError(null)
    try {
      await onSubmitProviderAuthPrompt(current.operationId, current.promptId, value)
      if (!mountedRef.current || promptRef.current?.promptId !== current.promptId) return
      updatePrompt(null)
    } catch (reason) {
      if (!mountedRef.current || promptRef.current?.promptId !== current.promptId) return
      updatePrompt({ ...current, submitting: false })
      setError(errorMessage(reason, '无法提交认证信息。'))
    }
  }

  async function cancelLogin(): Promise<void> {
    const current = operationRef.current
    if (current?.operationId === null || current === null || current.cancelling) return
    cancelRequestedRef.current = true
    clearTransientInput()
    updatePrompt(null)
    setNoticeState(null)
    updateOperation({ ...current, cancelling: true })
    setError(null)
    setStatus(`正在取消 ${current.providerId} 登录…`)
    try {
      await onCancelProviderLogin(current.operationId)
      if (mountedRef.current) setStatus('登录已取消。')
    } catch (reason) {
      if (!mountedRef.current) return
      cancelRequestedRef.current = false
      updateOperation({ ...current, cancelling: false })
      setError(errorMessage(reason, '无法取消登录。'))
    }
  }

  function openExternal(url: string): void {
    setError(null)
    void onOpenExternal(url).catch((reason: unknown) => {
      if (mountedRef.current) setError(errorMessage(reason, '无法打开链接。'))
    })
  }

  return (
    <>
      <section className="settings-group credentials-panel" aria-labelledby="provider-credentials-heading">
        <h3 id="provider-credentials-heading" className="settings-group-heading">Provider 凭证</h3>
        {status === null ? null : (
          <p className="credentials-status" role="status" aria-live="polite">{status}</p>
        )}
        {error === null ? null : (
          <p className="credentials-error" role="alert">{error}</p>
        )}
        {operation === null ? null : (
          <AuthOperationStatus
            operation={operation}
            notice={noticeState?.operationId === operation.operationId ? noticeState.notice : null}
            onOpenExternal={openExternal}
            onCancel={() => void cancelLogin()}
          />
        )}
        {loading ? (
          <div className="settings-empty-state" role="status">正在读取 Provider 凭证…</div>
        ) : configuredCredentials.length === 0 ? (
          <div className="settings-empty-state" role="status">
            <h3>暂无已配置的 Provider 凭证</h3>
          </div>
        ) : (
          <div className="credentials-list">
            {configuredCredentials.map((credential) => (
              <article className="settings-card settings-card-stacked credential-card" key={credential.providerId}>
                <div className="credential-card-heading">
                  <div>
                    <h3>{credential.providerName}</h3>
                    <code>{credential.providerId}</code>
                  </div>
                  <span className="settings-value-chip">
                    {credential.configured ? '已配置' : '未配置'}
                  </span>
                </div>
                <dl className="credential-details">
                  <div>
                    <dt>来源</dt>
                    <dd>{credential.source === null ? '无' : authSourceLabel(credential.source)}</dd>
                  </div>
                  <div>
                    <dt>已保存类型</dt>
                    <dd>{credential.storedCredentialType === null
                      ? '无'
                      : authTypeLabel(credential.storedCredentialType)}</dd>
                  </div>
                </dl>
                <div className="credential-actions">
                  {credential.methods.map((method) => (
                    <button
                      type="button"
                      key={`${method.type}:${method.name}`}
                      disabled={controlsDisabled}
                      aria-busy={
                        operation?.providerId === credential.providerId &&
                        operation.authType === method.type
                          ? true
                          : undefined
                      }
                      onClick={() => void login(credential, method)}
                    >
                      {operation?.providerId === credential.providerId &&
                      operation.authType === method.type
                        ? '登录中…'
                        : methodLabel(method)}
                    </button>
                  ))}
                  {credential.storedCredentialType === null ? null : (
                    <button
                      type="button"
                      disabled={controlsDisabled}
                      aria-busy={action === `logout:${credential.providerId}` ? true : undefined}
                      onClick={() => void logout(credential)}
                    >
                      {action === `logout:${credential.providerId}` ? '退出中…' : '退出登录'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="settings-group" aria-labelledby="custom-provider-settings-heading">
        <h3 id="custom-provider-settings-heading" className="settings-group-heading">
          自定义 Provider 配置
        </h3>
        <ProviderSettings
          busy={busy || operation !== null}
          onListProviders={onListProviders}
          onSaveProvider={onSaveProvider}
          onRemoveProvider={onRemoveProvider}
          onTestProvider={onTestProvider}
          onFetchModelPricing={onFetchModelPricing}
        />
      </section>

      {promptState === null ? null : createPortal(
        <AuthPromptDialog
          state={promptState}
          value={promptValue}
          inputRef={promptInputRef}
          optionsRef={promptOptionsRef}
          onValueChange={setPromptValue}
          onSubmit={submitPrompt}
          onCancel={() => void cancelLogin()}
        />,
        document.body
      )}
    </>
  )
}

function AuthOperationStatus({
  operation,
  notice,
  onOpenExternal,
  onCancel
}: {
  operation: AuthOperation
  notice: KernelProviderAuthNotice | null
  onOpenExternal: (url: string) => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <aside className="credential-auth-status" role="status" aria-live="polite">
      <div className="credential-auth-status-heading">
        <strong>{operation.cancelling ? '正在取消登录…' : `正在登录 ${operation.providerId}`}</strong>
        <button
          type="button"
          disabled={operation.operationId === null || operation.cancelling}
          onClick={onCancel}
        >
          {operation.cancelling ? '取消中…' : '取消'}
        </button>
      </div>
      {notice === null ? null : <AuthNotice notice={notice} onOpenExternal={onOpenExternal} />}
    </aside>
  )
}

function AuthNotice({
  notice,
  onOpenExternal
}: {
  notice: KernelProviderAuthNotice
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  if (notice.type === 'auth_url') {
    return (
      <div className="credential-auth-notice">
        {notice.instructions === null ? null : <p>{notice.instructions}</p>}
        <button type="button" onClick={() => onOpenExternal(notice.url)}>打开认证页面</button>
      </div>
    )
  }
  if (notice.type === 'device_code') {
    return (
      <div className="credential-auth-notice">
        <p>在认证页面输入设备码：</p>
        <code>{notice.userCode}</code>
        <button type="button" onClick={() => onOpenExternal(notice.verificationUri)}>
          打开验证页面
        </button>
        {notice.expiresInSeconds === null ? null : (
          <p>设备码将在 {notice.expiresInSeconds} 秒后过期。</p>
        )}
      </div>
    )
  }
  if (notice.type === 'progress') {
    return <p className="credential-auth-progress">{notice.message}</p>
  }
  return (
    <div className="credential-auth-notice">
      <p>{notice.message}</p>
      {notice.links.map((link) => (
        <button type="button" key={link.url} onClick={() => onOpenExternal(link.url)}>
          {link.label ?? '打开链接'}
        </button>
      ))}
    </div>
  )
}

function AuthPromptDialog({
  state,
  value,
  inputRef,
  optionsRef,
  onValueChange,
  onSubmit,
  onCancel
}: {
  state: AuthPromptState
  value: string
  inputRef: React.RefObject<HTMLInputElement | null>
  optionsRef: React.RefObject<HTMLDivElement | null>
  onValueChange: (value: string) => void
  onSubmit: (value: string) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const titleId = `provider-auth-prompt-${state.promptId}`
  const descriptionId = `provider-auth-prompt-description-${state.promptId}`
  const prompt = state.prompt
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    return () => {
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [state.promptId])
  return (
    <div
      className="credential-auth-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
          return
        }
        if (event.key !== 'Tab') return
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable === undefined || focusable.length === 0) {
          event.preventDefault()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (first === undefined || last === undefined) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <section
        ref={dialogRef}
        className="credential-auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={state.submitting}
      >
        <h2 id={titleId}>登录 {state.providerId}</h2>
        <p id={descriptionId}>{prompt.message}</p>
        {prompt.type === 'select' ? (
          <div className="credential-auth-options" ref={optionsRef}>
            {prompt.options.map((option) => (
              <button
                type="button"
                key={option.id}
                disabled={state.submitting}
                onClick={() => void onSubmit(option.id)}
              >
                <strong>{option.label}</strong>
                {option.description === null ? null : <span>{option.description}</span>}
              </button>
            ))}
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (value.length > 0) void onSubmit(value)
            }}
          >
            <label htmlFor={`provider-auth-input-${state.promptId}`}>
              {prompt.type === 'secret'
                ? '认证信息'
                : prompt.type === 'manual_code' ? '授权码' : '输入'}
            </label>
            <input
              ref={inputRef}
              id={`provider-auth-input-${state.promptId}`}
              type={prompt.type === 'secret' ? 'password' : 'text'}
              value={value}
              placeholder={prompt.placeholder ?? undefined}
              maxLength={65_536}
              autoComplete={prompt.type === 'secret' ? 'new-password' : 'off'}
              disabled={state.submitting}
              onChange={(event) => onValueChange(event.currentTarget.value)}
            />
            <div className="credential-auth-dialog-actions">
              <button type="button" disabled={state.submitting} onClick={onCancel}>取消</button>
              <button type="submit" disabled={state.submitting || value.length === 0}>
                {state.submitting ? '提交中…' : '提交'}
              </button>
            </div>
          </form>
        )}
        {prompt.type === 'select' ? (
          <div className="credential-auth-dialog-actions">
            <button type="button" disabled={state.submitting} onClick={onCancel}>取消</button>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function methodLabel(method: KernelProviderAuthMethod): string {
  if (method.label !== null) return method.label
  if (method.name.trim().length > 0) return method.name
  return method.type === 'oauth' ? 'OAuth 登录' : '输入 API Key'
}

function authTypeLabel(type: KernelProviderAuthType): string {
  return type === 'oauth' ? 'OAuth' : 'API Key'
}

function authSourceLabel(source: KernelProviderCredential['source']): string {
  if (source === 'stored') return 'Pi 已保存凭证'
  if (source === 'runtime') return '当前 Runtime'
  if (source === 'environment') return '环境变量'
  if (source === 'fallback') return 'Provider 默认来源'
  if (source === 'models_json_key') return '自定义 Provider API Key'
  if (source === 'models_json_command') return '自定义 Provider 命令'
  return '无'
}

function errorMessage(reason: unknown, fallback: string): string {
  void reason
  return fallback
}
