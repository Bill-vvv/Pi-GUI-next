import { useEffect, useId, useRef, useState } from 'react'

import {
  DESKTOP_CLIENT_DEFAULT_PORT,
  parseDesktopClientHostConfig,
  type DesktopHostProfileCommand,
  type DesktopClientConnectRequest,
  type DesktopHostCheckResult,
  type DesktopSshHostListing,
  type DesktopClientStatus
} from '../../../../shared/desktop-client-contract'
import { unknownErrorMessage } from '../../unknown-error-message'
import { Select } from '../../components/Select'
import './connect-host-panel.css'
import { DesktopEnvironmentPanel } from './DesktopEnvironmentPanel'

type ConnectHostPanelProps = {
  status: Extract<DesktopClientStatus, { mode: 'windows-remote' }>
  busy: boolean
  error: string | null
  onConnect: (request: DesktopClientConnectRequest) => Promise<void>
}

export function ConnectHostPanel({
  status,
  busy,
  error,
  onConnect
}: ConnectHostPanelProps): React.JSX.Element {
  const headingId = useId()
  const hostsId = useId()
  const profilesId = useId()
  const profiles = status.hostProfiles
  const selectedProfile = profiles?.profiles.find((profile) => profile.id === profiles.selectedId)
  const [profileName, setProfileName] = useState(selectedProfile?.name ?? '')
  const [profileBusy, setProfileBusy] = useState(false)
  const profileRequest = useRef<object | null>(null)
  const profileFocusPending = useRef(false)
  const profileDeleteButton = useRef<HTMLButtonElement>(null)
  const profileForgetButton = useRef<HTMLButtonElement>(null)
  const profileRetryButton = useRef<HTMLButtonElement>(null)
  const [profileRemoval, setProfileRemoval] = useState<{ id: string; revision: number; name: string; action: 'remove' | 'forget' } | null>(null)
  const discoveryRequest = useRef<object | null>(null)
  const [discovery, setDiscovery] = useState<DesktopSshHostListing | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [sshHostAlias, setSshHostAlias] = useState(status.lastHost?.sshHostAlias ?? '')
  const [localPort, setLocalPort] = useState(
    String(status.lastHost?.localPort ?? DESKTOP_CLIENT_DEFAULT_PORT)
  )
  const [desktopHostPort, setDesktopHostPort] = useState(
    String(status.lastHost?.desktopHostPort ?? DESKTOP_CLIENT_DEFAULT_PORT)
  )
  const [pairingCode, setPairingCode] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [cancellingCheck, setCancellingCheck] = useState(false)
  const [checkResult, setCheckResult] = useState<DesktopHostCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const checkRequest = useRef<{ id: string; cancelling: boolean; cancel: () => Promise<void> } | null>(null)
  const currentConfig = useRef('')
  currentConfig.current = JSON.stringify([sshHostAlias, localPort, desktopHostPort])
  const reconnecting = status.phase === 'reconnecting'
  const ending = status.phase === 'disconnecting' || status.phase === 'revoking'
  const changing = busy || reconnecting || checking || ending || profileBusy || status.phase === 'configuring' || status.phase === 'checking' || status.phase === 'connecting'
  const unavailable = profiles !== undefined && !profiles.ready
  const disabled = changing || unavailable
  const profileDirty = profiles !== undefined && (selectedProfile === undefined ||
    selectedProfile.config.sshHostAlias !== sshHostAlias.trim() || selectedProfile.config.localPort !== Number(localPort) ||
    selectedProfile.config.desktopHostPort !== Number(desktopHostPort) || selectedProfile.name !== profileName.trim())
  const canConnect = !disabled && !profileDirty
  const pairingRequired = !status.hasStoredCredential
  const displayedError = submitError ?? error ?? status.error
  useEffect(() => {
    if (profiles === undefined) return
    const selected = profiles.profiles.find((profile) => profile.id === profiles.selectedId)
    setProfileName(selected?.name ?? '')
    setSshHostAlias(selected?.config.sshHostAlias ?? '')
    setLocalPort(String(selected?.config.localPort ?? DESKTOP_CLIENT_DEFAULT_PORT))
    setDesktopHostPort(String(selected?.config.desktopHostPort ?? DESKTOP_CLIENT_DEFAULT_PORT))
    setPairingCode('')
    setSubmitError(null)
    setCheckResult(null)
    setProfileRemoval(null)
    // Only a new authoritative profile revision replaces the local draft.
  }, [profiles?.revision, profiles?.selectedId])
  useEffect(() => () => { profileRequest.current = null }, [])
  useEffect(() => {
    if (!changing && profileFocusPending.current) {
      profileFocusPending.current = false
      if (unavailable) profileRetryButton.current?.focus()
      else document.getElementById(profilesId)?.focus()
    }
  }, [changing, unavailable, profilesId])

  async function manageProfiles(command: DesktopHostProfileCommand): Promise<void> {
    if (changing || profileRequest.current !== null || (unavailable && command.type !== 'desktop-client.host-profiles.retry')) return
    const request = {}
    profileRequest.current = request
    setProfileBusy(true)
    setSubmitError(null)
    try {
      const api = window.piDesktopClient
      if (api === undefined) throw new Error('主机配置管理不可用。')
      await api.manageHostProfiles(command)
    } catch (cause) {
      if (profileRequest.current === request) setSubmitError(unknownErrorMessage(cause))
    } finally {
      if (profileRequest.current === request) { profileRequest.current = null; profileFocusPending.current = true; setProfileBusy(false) }
    }
  }

  async function saveProfile(): Promise<void> {
    if (disabled || profiles === undefined) return
    try {
      await manageProfiles({ type: 'desktop-client.host-profiles.save', expectedRevision: profiles.revision,
        id: profiles.selectedId, name: profileName.trim() || sshHostAlias.trim().slice(0, 80),
        config: parseDesktopClientHostConfig({ sshHostAlias: sshHostAlias.trim(), localPort: Number(localPort), desktopHostPort: Number(desktopHostPort) }) })
    } catch (cause) { setSubmitError(unknownErrorMessage(cause)) }
  }
  useEffect(() => {
    setDiscovering(false)
    return () => { discoveryRequest.current = null }
  }, [disabled])

  useEffect(() => {
    setCheckResult(null)
    setCheckError(null)
  }, [sshHostAlias, localPort, desktopHostPort])

  useEffect(() => () => {
    const pending = checkRequest.current
    checkRequest.current = null
    if (pending !== null) void pending.cancel().catch((error) => console.error('Host 检查取消失败：', unknownErrorMessage(error)))
  }, [])

  async function checkHost(): Promise<void> {
    if (disabled || checkRequest.current !== null) return
    const api = window.piDesktopClient
    if (!api) { setCheckError('桌面主机检查不可用。'); return }
    const id = crypto.randomUUID()
    const request = { id, cancelling: false, cancel: () => api.cancelHostCheck(id) }
    const configIdentity = currentConfig.current
    checkRequest.current = request
    setChecking(true)
    setCheckResult(null)
    setCheckError(null)
    try {
      const result = await api.checkHost(id, parseDesktopClientHostConfig({
        sshHostAlias: sshHostAlias.trim(), localPort: Number(localPort), desktopHostPort: Number(desktopHostPort)
      }))
      if (checkRequest.current === request && currentConfig.current === configIdentity) setCheckResult(result)
    } catch (reason) {
      if (checkRequest.current === request && currentConfig.current === configIdentity) setCheckError(unknownErrorMessage(reason))
    } finally {
      if (checkRequest.current === request) {
        checkRequest.current = null
        setChecking(false)
        setCancellingCheck(false)
      }
    }
  }

  async function cancelCheck(): Promise<void> {
    const request = checkRequest.current
    if (request === null || request.cancelling) return
    request.cancelling = true
    setCancellingCheck(true)
    try { await request.cancel() } catch (reason) {
      if (checkRequest.current === request) {
        request.cancelling = false
        setCancellingCheck(false)
        setCheckError(unknownErrorMessage(reason))
      }
    }
  }

  async function discoverHosts(): Promise<void> {
    if (disabled || discoveryRequest.current !== null) return
    const request = {}
    discoveryRequest.current = request
    setDiscovering(true)
    setDiscovery(null)
    setDiscoveryError(null)
    try {
      if (!window.piDesktopClient) throw new Error('桌面主机发现不可用。')
      const listing = await window.piDesktopClient.listSshHosts()
      if (discoveryRequest.current === request) setDiscovery(listing)
    } catch (reason) {
      if (discoveryRequest.current === request) setDiscoveryError(unknownErrorMessage(reason))
    } finally {
      if (discoveryRequest.current === request) {
        discoveryRequest.current = null
        setDiscovering(false)
      }
    }
  }
  const failureHint = unavailable ? '配置或凭证操作尚未完成，请点击“重试配置与凭证操作”。完成前无法连接或修改主机。' : status.failureKind === null ? null : {
    network: '请检查网络和 Linux 主机是否在线，并确认 Pi GUI 已启动，然后重试连接。',
    authentication: '设备凭证或配对码已失效。请在 Linux Pi GUI 中生成新的配对码后连接。',
    'credential-target': '此设备在该 Host 上没有有效配对（可能已撤销、已过期，或连接到了另一台 Host）。请核对目标主机，或在 Linux Pi GUI 中生成新的配对码后连接。原凭证未发送，也已保留。',
    occupied: '另一台已配对设备正在使用此 Host。请先在那台设备上断开，再点击连接；不会自动重试。',
    'ssh-authentication': 'SSH 登录失败。请先确认系统 SSH 可以登录该主机，再重试连接。',
    'host-key': 'SSH 主机身份校验失败。请在系统 SSH 中核实主机身份后再连接。',
    protocol: '请确认 Windows 和 Linux 使用同一版本、同一源码构建的 Pi GUI，并重新启动两端。',
    configuration: '请检查 SSH 主机别名和端口配置；本机端口需要可用。',
    unknown: '连接已停止。请根据下方错误排查原因后重试。'
  }[status.failureKind]

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canConnect) return
    setSubmitError(null)
    const code = pairingCode.trim()
    try {
      await onConnect({
        sshHostAlias: sshHostAlias.trim(),
        localPort: Number(localPort),
        desktopHostPort: Number(desktopHostPort),
        ...(profiles === undefined ? {} : { profile: { id: profiles.selectedId, revision: profiles.revision } }),
        ...(code.length === 0 ? {} : { pairingCode: code })
      })
    } catch (reason) {
      setSubmitError(unknownErrorMessage(reason))
    }
  }

  return (
    <main className="connect-host-screen">
      <form
        className="connect-host-panel"
        aria-labelledby={headingId}
        aria-busy={disabled}
        onSubmit={(event) => {
          void handleSubmit(event)
        }}
      >
        <div className="connect-host-copy">
          <h1 id={headingId}>连接 Linux Host</h1>
          <p>
            {status.phase === 'configuring' ? '正在保存主机配置和处理凭证，请等待完成。' : ending ? status.phase === 'revoking' ? '正在取消配对并释放连接，请等待完成。' : '正在断开连接，配对将保留。请等待连接释放。' : reconnecting
              ? '连接已中断，正在恢复。恢复后请核对最新对话；未确认的操作不会自动重新发送。'
              : status.hasStoredCredential
                ? '将使用 Windows Credential Manager 中已保存的桌面设备凭证。需要替换设备时再填写新的配对码。'
                : '使用系统 OpenSSH 的已有 Host alias，把 Windows 界面接到 Linux 上的 Pi。先在 Linux Pi GUI 设置页生成桌面配对码。不保存 SSH 密码，也不在 Windows 本地运行 Pi。'}
          </p>
        </div>
        {profiles === undefined ? null : <section className="connect-host-profiles" aria-label="已保存的主机" aria-busy={profileBusy || status.phase === 'configuring'}>
          <label htmlFor={profilesId}>已保存的主机</label>
          <Select id={profilesId} value={profiles.selectedId ?? ''} disabled={disabled}
            groups={[{ options: [
              { value: '', label: '新主机（未保存）' },
              ...profiles.profiles.map((profile) => ({ value: profile.id, label: profile.name, detail: `${profile.config.sshHostAlias}:${profile.config.desktopHostPort}` }))
            ] }]}
            onValueChange={(id) => { void manageProfiles({ type: 'desktop-client.host-profiles.select', id: id || null, expectedRevision: profiles.revision }) }} />
          <label className="connect-host-field"><span>主机名称</span><input name="profileName" value={profileName} maxLength={80}
            placeholder="留空使用 SSH 别名" disabled={disabled} onChange={(event) => setProfileName(event.target.value)} /></label>
          {unavailable ? <button ref={profileRetryButton} className="connect-host-action" type="button" disabled={changing}
            onClick={() => { void manageProfiles({ type: 'desktop-client.host-profiles.retry', expectedRevision: profiles.revision }) }}>重试配置与凭证操作</button> : null}
        </section>}
        <div className="connect-host-discovery" aria-busy={discovering}>
          <button className="connect-host-action" type="button" disabled={disabled || discovering} onClick={() => { void discoverHosts() }}>
            {discovering ? '正在读取 SSH 配置…' : discovery === null ? '从 SSH 配置选择主机' : '刷新 SSH 主机'}
          </button>
          {discoveryError === null ? null : <p className="connect-host-error" role="alert">{discoveryError}</p>}
          {discovery === null ? null : <>
            {discovery.hosts.length === 0 ? <p className="connect-host-status" role="status">未发现可选的主机别名，请在下方手动填写。</p> : <div className="connect-host-field">
              <label htmlFor={hostsId}>配置中的候选主机</label>
              <Select id={hostsId} value={discovery.hosts.some((host) => host.alias === sshHostAlias) ? sshHostAlias : ''}
                disabled={disabled || discovering}
                groups={[{ options: [
                  { value: '', label: '选择主机别名', disabled: true },
                  ...discovery.hosts.map((host) => ({ value: host.alias, label: host.alias, detail: `${host.filePath}:${host.line}` }))
                ] }]}
                onValueChange={(alias) => {
                  if (disabled || discovering) return
                  setSshHostAlias(alias)
                  setPairingCode('')
                  setSubmitError(null)
                }} />
            </div>}
            <p className="connect-host-status">仅列出配置中的别名；连接时检查实际配置与主机状态。</p>
            <details className="connect-host-sources">
              <summary>配置文件来源</summary>
              <ul>{discovery.searchedFiles.map((path) => <li key={path}>{path}</li>)}</ul>
            </details>
            {discovery.warnings.length === 0 ? null : <div className="connect-host-error" role="status">
              <p>部分配置需要检查，候选列表可能不完整：</p>
              <ul>{discovery.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>}
          </>}
        </div>
        <label className="connect-host-field">
          <span>SSH Host alias</span>
          <input
            name="sshHostAlias"
            autoComplete="off"
            spellCheck={false}
            value={sshHostAlias}
            required
            disabled={disabled}
            onChange={(event) => setSshHostAlias(event.target.value)}
          />
        </label>
        <div className="connect-host-ports">
          <label className="connect-host-field">
            <span>本机端口</span>
            <input
              name="localPort"
              inputMode="numeric"
              value={localPort}
              disabled={disabled}
              onChange={(event) => setLocalPort(event.target.value)}
            />
          </label>
          <label className="connect-host-field">
            <span>Host 端口</span>
            <input
              name="desktopHostPort"
              inputMode="numeric"
              value={desktopHostPort}
              disabled={disabled}
              onChange={(event) => setDesktopHostPort(event.target.value)}
            />
          </label>
        </div>
        {profiles === undefined ? null : <section className="connect-host-profiles" aria-label="主机配置操作">
          <div className="connect-host-profile-actions">
            <button className="connect-host-action" type="button" disabled={disabled} onClick={() => { void saveProfile() }}>保存主机配置</button>
            {selectedProfile === undefined ? null : <>
              <button ref={profileDeleteButton} className="connect-host-action" type="button" disabled={disabled} onClick={() => setProfileRemoval({ id: selectedProfile.id, name: selectedProfile.name, revision: profiles.revision, action: 'remove' })}>删除配置</button>
              <button ref={profileForgetButton} className="connect-host-action" type="button" disabled={disabled || !status.hasStoredCredential} onClick={() => setProfileRemoval({ id: selectedProfile.id, name: selectedProfile.name, revision: profiles.revision, action: 'forget' })}>忘记凭证</button>
            </>}
          </div>
          {profileDirty ? <p className="connect-host-status">请先保存配置再连接。修改 SSH 别名或 Host 端口后需要重新配对。</p> : null}
          {profileRemoval === null ? null : <div className="connect-host-profile-confirm" role="group" aria-label="确认移除本机数据">
            <p className="connect-host-status">{profileRemoval.action === 'remove' ? '删除配置和本机凭证' : '忘记本机凭证'}：{profileRemoval.name}。此操作不会撤销 Host 上的配对；需要撤销访问时，请先连接并取消配对。</p>
            <button className="connect-host-action" type="button" disabled={disabled} onClick={() => { void manageProfiles({ type: profileRemoval.action === 'remove' ? 'desktop-client.host-profiles.remove' : 'desktop-client.host-profiles.forget', id: profileRemoval.id, expectedRevision: profileRemoval.revision }) }}>{profileRemoval.action === 'remove' ? '确认删除' : '确认忘记'}</button>
            <button className="connect-host-action" type="button" disabled={disabled} onClick={() => {
              (profileRemoval.action === 'remove' ? profileDeleteButton : profileForgetButton).current?.focus()
              setProfileRemoval(null)
            }}>取消</button>
          </div>}
        </section>}
        <label className="connect-host-field">
          <span>{pairingRequired ? '6 位配对码' : '6 位配对码（可选）'}</span>
          <input
            name="pairingCode"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            minLength={pairingRequired ? 6 : undefined}
            required={pairingRequired}
            value={pairingCode}
            disabled={disabled}
            onChange={(event) => setPairingCode(event.target.value.replaceAll(/\D/gu, '').slice(0, 6))}
          />
        </label>
        {status.recovery === null ? null : (
          <p className="connect-host-status" role="status" aria-live="polite">
            {reconnecting
              ? status.recovery.delayMs > 0
                ? `等待 ${status.recovery.delayMs / 1_000} 秒后进行第 ${status.recovery.attempt}/${status.recovery.maxAttempts} 次重连。`
                : `正在进行第 ${status.recovery.attempt}/${status.recovery.maxAttempts} 次重连。`
              : `自动重连已停止，已尝试 ${status.recovery.attempt}/${status.recovery.maxAttempts} 次。`}
          </p>
        )}
        {displayedError === null ? null : (
          <div className="connect-host-error" role={reconnecting ? 'status' : 'alert'}>
            {!reconnecting && failureHint !== null ? <p>{failureHint}</p> : null}
            <p>{displayedError}</p>
          </div>
        )}
        <section className="connect-host-check" aria-label="Host 连接检查" aria-busy={checking || status.phase === 'checking'}>
          <button className="connect-host-action" type="button" disabled={disabled} onClick={() => { void checkHost() }}>检查 Host</button>
          {checking ? <button className="connect-host-action" type="button" disabled={cancellingCheck} onClick={() => { void cancelCheck() }}>{cancellingCheck ? '正在停止检查…' : '取消检查'}</button> : null}
          <p className="connect-host-status">临时连接所填主机，检查 SSH、端口和 Host 版本；无需配对码，不会启动任务。</p>
          {checking || status.phase === 'checking' ? <p className="connect-host-status" role="status">正在检查并等待临时连接释放…</p> : null}
          {checkError === null ? null : <p className="connect-host-error" role="alert">{checkError}</p>}
          {checkResult === null ? null : <div role="status" className="connect-host-check-result">
            <p>{checkResult.outcome === 'passed' ? '本次检查通过。正式连接时会重新检查并完成设备认证。' : checkResult.outcome === 'cancelled' ? '检查已取消。' : '检查未通过，请处理下列问题后重试。'}</p>
            <ul>{checkResult.steps.map((step) => <li key={step.stage} data-check-status={step.status}>
              <span>{{ 'local-port': '本机端口', 'ssh-executable': '系统 OpenSSH', 'ssh-configuration': 'SSH 别名配置', 'ssh-tunnel': 'SSH 登录与隧道', host: 'Host 服务与版本' }[step.stage]}：{{ passed: '通过', failed: '失败', skipped: '未完成' }[step.status]}</span>
              {step.detail === null ? null : <p>{step.detail}</p>}
            </li>)}</ul>
            {checkResult.cleanupError === null ? null : <p className="connect-host-error">临时 SSH 进程释放失败：{checkResult.cleanupError}。请关闭客户端后重试。</p>}
          </div>}
        </section>
        <button className="connect-host-action" type="submit" disabled={!canConnect}>
          {status.phase === 'configuring' || profileBusy ? '正在处理配置…' : unavailable ? '配置待修复' : ending ? '正在释放连接…' : checking || status.phase === 'checking' ? '检查中…' : reconnecting ? '正在重新连接…' : disabled ? '正在连接…' : displayedError !== null ? '重试连接' : '连接'}
        </button>
        <DesktopEnvironmentPanel disabled={disabled} />
      </form>
    </main>
  )
}
