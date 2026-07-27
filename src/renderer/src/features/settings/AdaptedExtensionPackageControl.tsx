import { useEffect, useRef, useState } from 'react'

import type { KernelInstalledPackage } from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'

type AdaptedExtensionPackageControlProps = {
  heading: string
  idPrefix: string
  packageName: string
  detailUrl: string
  description: string
  notice: React.ReactNode
  busy: boolean
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onSetEnabled: (enabled: boolean) => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
}

export function AdaptedExtensionPackageControl({
  heading,
  idPrefix,
  packageName,
  detailUrl,
  description,
  notice,
  busy,
  onListPiPackages,
  onInstallPiDevPackage,
  onSetEnabled,
  onOpenExternal
}: AdaptedExtensionPackageControlProps): React.JSX.Element {
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
    try {
      const packages = await onListPiPackages()
      if (requestRevision.current !== revision) return
      const pkg = packages.find(({ source }) => isPackageSource(source, packageName)) ?? null
      setInstalledPackage(pkg)
    } catch (loadError) {
      if (requestRevision.current !== revision) return
      setInstalledPackage(null)
      setError(`读取失败：${errorMessage(loadError)}`)
    } finally {
      if (requestRevision.current === revision) setLoading(false)
    }
  }

  async function installPackage(): Promise<void> {
    if (!window.confirm(
      `安装 Package「${packageName}」？第三方 Package 会以当前用户的完整系统权限运行，请先审查源码。`
    )) return
    setActing(true)
    setError(null)
    try {
      await onInstallPiDevPackage(packageName)
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
      await onSetEnabled(enabled)
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
      <p className="settings-subagent-notice">{notice}</p>
    </section>
  )
}

function isPackageSource(source: string, packageName: string): boolean {
  const base = `npm:${packageName}`
  return source === base || source.startsWith(`${base}@`)
}
