import { useEffect, useRef, useState } from 'react'

import {
  SUBAGENT_PACKAGE_NAME,
  type KernelInstalledPackage,
  type SubagentSettings as SubagentSettingsValue
} from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'

const SUBAGENT_PACKAGE_SOURCE = `npm:${SUBAGENT_PACKAGE_NAME}`
const SUBAGENT_DETAIL_URL = 'https://pi.dev/packages/%40mjakl/pi-subagent'

export type SubagentPackageState = 'loading' | 'not-installed' | 'enabled' | 'disabled' | 'error'

type SubagentPackageControlProps = {
  heading: string
  idPrefix: string
  busy: boolean
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onSetSubagentEnabled: (enabled: boolean) => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  onPackageStateChange?: (state: SubagentPackageState) => void
}

export function SubagentPackageControl({
  heading,
  idPrefix,
  busy,
  onListPiPackages,
  onInstallPiDevPackage,
  onSetSubagentEnabled,
  onOpenExternal,
  onPackageStateChange
}: SubagentPackageControlProps): React.JSX.Element {
  const [installedPackage, setInstalledPackage] = useState<KernelInstalledPackage | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRevision = useRef(0)

  useEffect(() => {
    void loadPackage()
    return () => {
      requestRevision.current += 1
    }
  }, [])

  async function loadPackage(): Promise<void> {
    const revision = requestRevision.current + 1
    requestRevision.current = revision
    setLoading(true)
    setError(null)
    onPackageStateChange?.('loading')
    try {
      const packages = await onListPiPackages()
      if (requestRevision.current !== revision) return
      const pkg = packages.find(({ source }) => isSubagentPackageSource(source)) ?? null
      setInstalledPackage(pkg)
      onPackageStateChange?.(
        pkg === null ? 'not-installed' : pkg.extensionEnabled ? 'enabled' : 'disabled'
      )
    } catch (loadError) {
      if (requestRevision.current !== revision) return
      setInstalledPackage(null)
      setError(`读取失败：${errorMessage(loadError)}`)
      onPackageStateChange?.('error')
    } finally {
      if (requestRevision.current === revision) setLoading(false)
    }
  }

  async function installPackage(): Promise<void> {
    if (!window.confirm(
      `安装 Package「${SUBAGENT_PACKAGE_NAME}」？第三方 Package 会以当前用户的完整系统权限运行，请先审查源码。`
    )) return
    setActing(true)
    setError(null)
    try {
      await onInstallPiDevPackage(SUBAGENT_PACKAGE_NAME)
      await loadPackage()
    } catch (installError) {
      setError(`安装失败：${errorMessage(installError)}`)
    } finally {
      setActing(false)
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    setActing(true)
    setError(null)
    try {
      await onSetSubagentEnabled(enabled)
      await loadPackage()
    } catch (updateError) {
      setError(`${enabled ? '开启' : '关闭'}失败：${errorMessage(updateError)}`)
    } finally {
      setActing(false)
    }
  }

  const headingId = `${idPrefix}-heading`
  const status = loading
    ? '正在读取安装状态…'
    : installedPackage === null
      ? '未安装'
      : installedPackage.extensionEnabled ? '已开启' : '已关闭'

  return (
    <section className="settings-group" aria-labelledby={headingId}>
      <h3 id={headingId} className="settings-group-heading">{heading}</h3>
      <div className="settings-group-card">
        <div className="settings-row settings-subagent-package-row">
          <div className="settings-row-copy">
            <h4>{SUBAGENT_PACKAGE_NAME}</h4>
            <p>{status} · 为 Pi 提供可委派的 Subagent Extension</p>
          </div>
          <div className="settings-subagent-actions">
            <button
              type="button"
              className="settings-link-button"
              disabled={acting}
              onClick={() => {
                setError(null)
                void onOpenExternal(SUBAGENT_DETAIL_URL).catch((openError) => {
                  setError(`无法打开详情：${errorMessage(openError)}`)
                })
              }}
            >
              详情
            </button>
            {error !== null && installedPackage === null ? (
              <button
                type="button"
                className="settings-link-button"
                disabled={busy || acting}
                onClick={() => void loadPackage()}
              >
                重试
              </button>
            ) : installedPackage === null ? (
              <button
                type="button"
                className="settings-extension-remove"
                disabled={busy || acting || loading}
                onClick={() => void installPackage()}
              >
                {acting ? '安装中…' : '安装'}
              </button>
            ) : (
              <div className="settings-subagent-package-select">
                <Select
                  id={`${idPrefix}-enabled`}
                  value={installedPackage.extensionEnabled ? 'enabled' : 'disabled'}
                  groups={[{
                    options: [
                      { value: 'enabled', label: '开启' },
                      { value: 'disabled', label: '关闭' }
                    ]
                  }]}
                  disabled={busy || acting || loading}
                  onValueChange={(value) => {
                    if (value === 'enabled' || value === 'disabled') {
                      void setEnabled(value === 'enabled')
                    }
                  }}
                />
              </div>
            )}
          </div>
        </div>
        {error === null ? null : (
          <p className="settings-subagent-error" role="alert">{error}</p>
        )}
      </div>
      <p className="settings-subagent-notice">
        安装与启停会在新建或显式重载 Session 后生效。
      </p>
    </section>
  )
}

type SubagentSettingsProps = {
  settings: SubagentSettingsValue
  busy: boolean
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onSetSubagentEnabled: (enabled: boolean) => Promise<void>
  onSetSubagent: (settings: SubagentSettingsValue) => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
}

export function SubagentSettings({
  settings,
  busy,
  onListPiPackages,
  onInstallPiDevPackage,
  onSetSubagentEnabled,
  onSetSubagent,
  onOpenExternal
}: SubagentSettingsProps): React.JSX.Element {
  const [packageState, setPackageState] = useState<SubagentPackageState>('loading')
  const settingsDisabled = busy || packageState !== 'enabled'

  return (
    <>
      <div className="settings-section-heading">
        <h2>Subagent</h2>
      </div>
      <SubagentPackageControl
        heading="Package"
        idPrefix="settings-subagent-package"
        busy={busy}
        onListPiPackages={onListPiPackages}
        onInstallPiDevPackage={onInstallPiDevPackage}
        onSetSubagentEnabled={onSetSubagentEnabled}
        onOpenExternal={onOpenExternal}
        onPackageStateChange={setPackageState}
      />
      <section className="settings-group" aria-labelledby="settings-subagent-runtime-heading">
        <h3 id="settings-subagent-runtime-heading" className="settings-group-heading">运行设置</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>最大嵌套深度</h4>
              <p>限制 Subagent 继续委派子任务的层数</p>
            </div>
            <div className="settings-row-control settings-theme-control">
              <Select
                id="settings-subagent-max-depth"
                value={String(settings.maxDepth)}
                groups={[{
                  options: [1, 2, 3].map((value) => ({
                    value: String(value),
                    label: String(value)
                  }))
                }]}
                disabled={settingsDisabled}
                onValueChange={(value) => {
                  const maxDepth = Number(value)
                  if (maxDepth !== 1 && maxDepth !== 2 && maxDepth !== 3) return
                  void onSetSubagent({ ...settings, maxDepth }).catch(() => undefined)
                }}
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>循环保护</h4>
              <p>阻止同一委派链路重复进入已经出现过的 Agent</p>
            </div>
            <div className="settings-row-control settings-theme-control">
              <Select
                id="settings-subagent-prevent-cycles"
                value={settings.preventCycles ? 'enabled' : 'disabled'}
                groups={[{
                  options: [
                    { value: 'enabled', label: '开启' },
                    { value: 'disabled', label: '关闭' }
                  ]
                }]}
                disabled={settingsDisabled}
                onValueChange={(value) => {
                  if (value !== 'enabled' && value !== 'disabled') return
                  void onSetSubagent({
                    ...settings,
                    preventCycles: value === 'enabled'
                  }).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
        <p className="settings-subagent-notice">
          运行设置会在新建或显式重载 Session 后生效。
        </p>
      </section>
    </>
  )
}

function isSubagentPackageSource(source: string): boolean {
  return source === SUBAGENT_PACKAGE_SOURCE || source.startsWith(`${SUBAGENT_PACKAGE_SOURCE}@`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
