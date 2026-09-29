import { useEffect, useRef, useState } from 'react'

import type {
  KernelInstalledPackage,
  KernelPiPackageInstallJob
} from '../../../../shared/kernel-contract'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'
import { findUniqueInstalledPackage } from './installed-package-selection'
import { SettingsSwitch } from './SettingsSwitch'
import { useSettingsConfirm } from './SettingsConfirmDialog'

/** Installation and enablement as read from Pi's package list. */
export type AdaptedPackageState = 'loading' | 'not-installed' | 'enabled' | 'disabled' | 'error'

type AdaptedExtensionPackageControlProps = {
  heading: string
  idPrefix: string
  packageName: string
  detailUrl: string
  description: string
  notice: React.ReactNode
  busy: boolean
  packageInstallJobs: KernelPiPackageInstallJob[]
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onSetEnabled: (enabled: boolean) => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  /** Lets the owning page follow the same package read instead of listing packages again. */
  onStateChange?: (state: AdaptedPackageState) => void
}

export function AdaptedExtensionPackageControl({
  heading,
  idPrefix,
  packageName,
  detailUrl,
  description,
  notice,
  busy,
  packageInstallJobs,
  onListPiPackages,
  onInstallPiDevPackage,
  onSetEnabled,
  onOpenExternal,
  onStateChange
}: AdaptedExtensionPackageControlProps): React.JSX.Element {
  const [installedPackage, setInstalledPackage] = useState<KernelInstalledPackage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { confirm, confirmDialog } = useSettingsConfirm()
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
    try {
      const packages = await onListPiPackages()
      if (requestRevision.current !== revision) return
      const pkg = findUniqueInstalledPackage(packages, packageName)
      setInstalledPackage(pkg)
      setLoadFailed(false)
    } catch (loadError) {
      if (requestRevision.current !== revision) return
      setInstalledPackage(null)
      setLoadFailed(true)
      setError(`读取失败：${errorMessage(loadError)}`)
    } finally {
      if (requestRevision.current === revision) setLoading(false)
    }
  }

  async function installPackage(): Promise<void> {
    if (!(await confirm({
      title: `安装 Package「${packageName}」？`,
      description: '第三方 Package 会以当前用户的完整系统权限运行，请先审查源码。',
      confirmLabel: '安装'
    }))) return
    setActing(true)
    setError(null)
    try {
      await onInstallPiDevPackage(packageName)
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
      await onSetEnabled(enabled)
      await loadPackage()
    } catch (updateError) {
      setError(`${enabled ? '开启' : '关闭'}失败：${errorMessage(updateError)}`)
    } finally {
      setActing(false)
    }
  }

  const headingId = `${idPrefix}-heading`
  const packageInstallJob = [...packageInstallJobs]
    .reverse()
    .find(({ name }) => name === packageName) ?? null
  const packageInstalling = packageInstallJob?.status === 'queued' ||
    packageInstallJob?.status === 'running'
  const packageInstallError = packageInstallJob?.status === 'failed'
    ? packageInstallJob.error
    : null
  useEffect(() => {
    if (
      packageInstallJob?.status !== 'succeeded' &&
      packageInstallJob?.status !== 'failed'
    ) return
    void loadPackage()
  }, [packageInstallJob?.id, packageInstallJob?.status])
  const status = loading
    ? '正在读取安装状态…'
    : packageInstalling
      ? packageInstallJob?.status === 'queued' ? '等待安装…' : '正在后台安装…'
    : installedPackage === null
      ? packageInstallError === null ? '未安装' : '安装失败'
      : installedPackage.extensionEnabled ? '已开启' : '已关闭'
  const displayedError = error ?? packageInstallError
  const packageState: AdaptedPackageState = loading
    ? 'loading'
    : loadFailed
      ? 'error'
      : installedPackage === null
        ? 'not-installed'
        : installedPackage.extensionEnabled ? 'enabled' : 'disabled'
  useEffect(() => {
    onStateChange?.(packageState)
  }, [onStateChange, packageState])

  return (
    <section className="settings-group settings-group-inline" aria-labelledby={headingId}>
      <h3 id={headingId} className="settings-group-heading">{heading}</h3>
      <div className="settings-group-card">
        <div className="settings-row settings-subagent-package-row">
          <div className="settings-row-copy">
            <h4>{packageName}</h4>
            <p>{status} · {description}</p>
          </div>
          <div className="settings-subagent-actions">
            <button
              type="button"
              className="settings-link-button"
              disabled={acting}
              onClick={() => {
                setError(null)
                void onOpenExternal(detailUrl).catch((openError) => {
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
                disabled={busy || acting || loading || packageInstalling}
                onClick={() => void installPackage()}
              >
                {acting || packageInstalling ? '后台安装中…' : '安装'}
              </button>
            ) : (
              <SettingsSwitch
                id={`${idPrefix}-enabled`}
                label={`启用 ${packageName}`}
                checked={installedPackage.extensionEnabled}
                disabled={busy || acting || loading}
                onCheckedChange={(enabled) => void setEnabled(enabled)}
              />
            )}
          </div>
        </div>
        {displayedError === null ? null : (
          <p className="settings-feedback settings-feedback-error settings-feedback-divided" role="alert">
            {error === null ? `安装失败：${displayedError}` : displayedError}
          </p>
        )}
      </div>
      <p className="settings-feedback">{notice}</p>
      {confirmDialog}
    </section>
  )
}
