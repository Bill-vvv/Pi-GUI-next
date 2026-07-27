import { useEffect, useRef, useState } from 'react'

import type { KernelInstalledPackage } from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'

const ADVISOR_PACKAGE_NAME = 'pi-gui-multi-advisor'

type AdvisorExtensionPackageControlProps = {
  busy: boolean
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onSetEnabled: (enabled: boolean) => Promise<void>
}

export function AdvisorExtensionPackageControl({
  busy,
  onListPiPackages,
  onSetEnabled
}: AdvisorExtensionPackageControlProps): React.JSX.Element {
  const [matches, setMatches] = useState<KernelInstalledPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRevision = useRef(0)

  useEffect(() => {
    void loadPackages()
    return () => {
      requestRevision.current += 1
    }
  }, [])

  async function loadPackages(): Promise<void> {
    const revision = requestRevision.current + 1
    requestRevision.current = revision
    setLoading(true)
    setError(null)
    try {
      const packages = await onListPiPackages()
      if (requestRevision.current !== revision) return
      setMatches(packages.filter(({ source }) => isAdvisorPackageSource(source)))
    } catch (loadError) {
      if (requestRevision.current !== revision) return
      setMatches([])
      setError(`读取资源状态失败：${errorMessage(loadError)}`)
    } finally {
      if (requestRevision.current === revision) setLoading(false)
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    if (matches.length !== 1) return
    setActing(true)
    setError(null)
    try {
      await onSetEnabled(enabled)
      await loadPackages()
    } catch (updateError) {
      setError(`${enabled ? '开启' : '关闭'}资源失败：${errorMessage(updateError)}`)
    } finally {
      setActing(false)
    }
  }

  const installedPackage = matches.length === 1 ? matches[0]! : null
  const status = loading
    ? '正在读取安装状态…'
    : matches.length === 0
      ? '未找到已安装资源'
      : matches.length > 1
        ? `检测到 ${matches.length} 个匹配资源`
        : installedPackage?.extensionEnabled ? '资源已开启' : '资源已关闭'

  return (
    <section
      className="settings-group settings-group-inline"
      aria-labelledby="settings-advisor-extension-heading"
    >
      <h3 id="settings-advisor-extension-heading" className="settings-group-heading">
        扩展资源
      </h3>
      <div className="settings-group-card">
        <div className="settings-row">
          <div className="settings-row-copy">
            <h4>
              {installedPackage === null
                ? ADVISOR_PACKAGE_NAME
                : (
                    <label htmlFor="settings-advisor-extension-enabled">
                      {ADVISOR_PACKAGE_NAME}
                    </label>
                  )}
            </h4>
            <p>{status}</p>
          </div>
          <div className="settings-subagent-actions">
            {error !== null ? (
              <button
                type="button"
                className="settings-link-button"
                disabled={busy || acting || loading}
                onClick={() => void loadPackages()}
              >
                重试
              </button>
            ) : installedPackage === null ? null : (
              <div className="settings-subagent-package-select">
                <Select
                  id="settings-advisor-extension-enabled"
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
        {matches.length > 1 ? (
          <p className="settings-advisor-error" role="alert">
            存在多个匹配的 Advisor 资源，请先在 Pi 配置中移除冲突项，再返回此处控制。
          </p>
        ) : null}
        {error === null ? null : (
          <p className="settings-advisor-error" role="alert">{error}</p>
        )}
      </div>
      {loading || error !== null || matches.length !== 0 ? null : (
        <p className="settings-advisor-notice">
          请手动安装并配置 <code>{ADVISOR_PACKAGE_NAME}</code>；此页面不会代替你安装第三方资源。
        </p>
      )}
      <p className="settings-advisor-notice">
        扩展资源开关仅对显式重载或新建 Session 生效，不等同于上方的实时系统开关。
      </p>
    </section>
  )
}

function isAdvisorPackageSource(source: string): boolean {
  if (source === ADVISOR_PACKAGE_NAME) return true
  if (/^npm:pi-gui-multi-advisor(?:@[^/]+)?$/u.test(source)) return true
  if (!isLocalPathSource(source)) return false
  const normalized = source.replace(/[\\/]+$/u, '')
  if (normalized.length === 0) return false
  return normalized.split(/[\\/]/u).at(-1) === ADVISOR_PACKAGE_NAME
}

function isLocalPathSource(source: string): boolean {
  return source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~/') ||
    source.startsWith('\\\\') ||
    /^[a-z]:[\\/]/iu.test(source) ||
    (!/^[a-z][a-z0-9+.-]*:/iu.test(source) && /[\\/]/u.test(source))
}
