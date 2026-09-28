import { useEffect, useId, useState } from 'react'
import type { DesktopEnvironmentStatus } from '../../../../shared/desktop-settings-contract'
import { Select } from '../../components/Select'
import { unknownErrorMessage } from '../../unknown-error-message'
import './desktop-environment-panel.css'

export function DesktopEnvironmentPanel({ disabled = false }: { disabled?: boolean }): React.JSX.Element | null {
  const id = useId()
  const [status, setStatus] = useState<DesktopEnvironmentStatus | null>(null)
  const [mode, setMode] = useState('ssh')
  const [distribution, setDistribution] = useState('Ubuntu-24.04')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    if (!window.piDesktopClient?.getEnvironment) return
    void window.piDesktopClient.getEnvironment().then((value) => {
      if (!active) return
      setStatus(value)
      if (value.current !== null) setMode(value.current.mode)
      if (value.current?.mode === 'wsl') setDistribution(value.current.distribution)
    }, (reason) => { if (active) setError(unknownErrorMessage(reason)) })
    return () => { active = false }
  }, [])
  if (error !== null && status === null) return <p role="alert">{error}</p>
  if (status?.current === null || status === null) return null
  const current = status.current.mode === 'ssh' ? 'SSH · Linux Host' : `WSL · ${status.current.distribution}`
  const controlsDisabled = disabled || busy
  const unchanged = mode === status.current.mode && (status.current.mode === 'ssh' || distribution === status.current.distribution)
  return (
    <section className="desktop-environment-panel" aria-labelledby={id} aria-busy={busy}>
      <h3 id={id}>运行环境</h3>
      <p>当前：{current}</p>
      {status.canSwitch ? <>
        <label htmlFor={`${id}-mode`}>目标运行环境</label>
        <Select id={`${id}-mode`} value={mode} groups={[{ options: [{ value: 'ssh', label: 'SSH · Linux Host' }, { value: 'wsl', label: '本机 WSL' }] }]} disabled={controlsDisabled} onValueChange={setMode} />
        {mode === 'wsl' ? <label>发行版<input value={distribution} maxLength={128} disabled={controlsDisabled} onChange={(event) => setDistribution(event.target.value)} /></label> : null}
        <button className="connect-host-action" type="button" disabled={controlsDisabled || unchanged || (mode === 'wsl' && distribution.trim().length === 0)} onClick={() => {
          setBusy(true)
          setError(null)
          void window.piDesktopClient!.switchEnvironment(mode === 'ssh' ? { mode: 'ssh' } : { mode: 'wsl', distribution: distribution.trim() })
            .catch((reason) => setError(unknownErrorMessage(reason)))
            .finally(() => setBusy(false))
        }}>重启并切换</button>
      </> : <p>开发模式切换请使用 workspace start 或 wsl。</p>}
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  )
}
