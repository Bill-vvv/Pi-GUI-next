import { useEffect, useRef, useState } from 'react'

import type { KernelInstalledPackage } from '../../../../shared/kernel-contract'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'
import {
  isWorkbenchAction,
  type WorkbenchOperation
} from '../../workbench-actions'

type InstalledPackagesProps = {
  busy: boolean
  pendingAction: WorkbenchOperation | null
  revision: number
  onList: () => Promise<KernelInstalledPackage[]>
  onRemove: (source: string) => Promise<void>
  onUpdate: (source: string) => Promise<void>
  onUpdateAll: () => Promise<void>
}

export function InstalledPackages({
  busy,
  pendingAction,
  revision,
  onList,
  onRemove,
  onUpdate,
  onUpdateAll
}: InstalledPackagesProps): React.JSX.Element {
  const [packages, setPackages] = useState<KernelInstalledPackage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actingSource, setActingSource] = useState<string | null>(null)
  const requestRevision = useRef(0)

  useEffect(() => {
    void loadPackages()
    return () => {
      requestRevision.current += 1
    }
  }, [revision])

  async function loadPackages(): Promise<void> {
    const request = requestRevision.current + 1
    requestRevision.current = request
    setError(null)
    try {
      const result = await onList()
      if (requestRevision.current === request) setPackages(result)
    } catch (loadError) {
      if (requestRevision.current === request) setError(errorMessage(loadError))
    }
  }

  async function updatePackage(source: string): Promise<void> {
    setActingSource(source)
    setError(null)
    try {
      await onUpdate(source)
    } catch (updateError) {
      setError(`更新失败：${errorMessage(updateError)}`)
    } finally {
      setActingSource(null)
    }
  }

  async function removePackage(source: string): Promise<void> {
    if (!window.confirm(`卸载 Package「${source}」？其中启用的所有资源都会一并移除。`)) return
    setActingSource(source)
    setError(null)
    try {
      await onRemove(source)
    } catch (removeError) {
      setError(`卸载失败：${errorMessage(removeError)}`)
    } finally {
      setActingSource(null)
    }
  }

  const packageActionPending =
    isWorkbenchAction(pendingAction, 'remove-pi-package') ||
    isWorkbenchAction(pendingAction, 'update-pi-package') ||
    isWorkbenchAction(pendingAction, 'update-pi-packages')

  return (
    <section className="settings-group" aria-labelledby="settings-installed-packages-heading">
      <div className="settings-group-heading-row">
        <h3 id="settings-installed-packages-heading" className="settings-group-heading">已安装</h3>
        <button
          className="settings-link-button"
          type="button"
          disabled={busy || packages === null || packages.length === 0 || packageActionPending}
          onClick={() => {
            setError(null)
            void onUpdateAll().catch((updateError) => {
              setError(`更新失败：${errorMessage(updateError)}`)
            })
          }}
        >
          {isWorkbenchAction(pendingAction, 'update-pi-packages') ? '更新中…' : '全部更新'}
        </button>
      </div>

      <div className="settings-group-card settings-package-manager">
        {packages === null && error === null ? (
          <p className="settings-extension-status" role="status">正在读取已安装 Package…</p>
        ) : null}
        {error === null ? null : (
          <p className="settings-extension-error" role="alert">{error}</p>
        )}
        {packages?.length === 0 ? (
          <div className="settings-pi-dev-empty" role="status">尚未安装用户级 Package。</div>
        ) : null}
        {packages === null || packages.length === 0 ? null : (
          <div className="settings-resource-list">
            {packages.map((pkg) => (
              <article className="settings-resource-row" key={pkg.source}>
                <div className="settings-resource-copy">
                  <h3><code>{pkg.source}</code></h3>
                  {pkg.filtered ? <p>部分资源已配置</p> : null}
                </div>
                <div className="settings-resource-actions">
                  <button
                    type="button"
                    className="settings-link-button"
                    disabled={busy || packageActionPending}
                    onClick={() => void updatePackage(pkg.source)}
                  >
                    {actingSource === pkg.source &&
                    isWorkbenchAction(pendingAction, 'update-pi-package')
                      ? '更新中…'
                      : '更新'}
                  </button>
                  <button
                    type="button"
                    className="settings-extension-remove"
                    disabled={busy || packageActionPending}
                    onClick={() => void removePackage(pkg.source)}
                  >
                    {actingSource === pkg.source &&
                    isWorkbenchAction(pendingAction, 'remove-pi-package')
                      ? '卸载中…'
                      : '卸载'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
