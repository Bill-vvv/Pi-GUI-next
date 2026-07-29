import { useEffect, useRef, useState } from 'react'

import type {
  KernelPiDevCatalog,
  KernelPiDevPackage
} from '../../../../shared/kernel-contract'
import piDevLogoUrl from '../../assets/pi-dev-logo.svg'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'
import {
  isWorkbenchAction,
  type WorkbenchOperation
} from '../../workbench-actions'

type PiDevCatalogProps = {
  kind: 'package' | 'extension'
  busy: boolean
  pendingAction: WorkbenchOperation | null
  revision: number
  onSearch: (query: string) => Promise<KernelPiDevCatalog>
  onInstall: (name: string) => Promise<void>
  onRemove: (source: string) => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
}

export function PiDevCatalog({
  kind,
  busy,
  pendingAction,
  revision,
  onSearch,
  onInstall,
  onRemove,
  onOpenExternal
}: PiDevCatalogProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [catalog, setCatalog] = useState<KernelPiDevCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [actingPackage, setActingPackage] = useState<string | null>(null)
  const requestRevision = useRef(0)

  useEffect(() => {
    void loadCatalog('')
    return () => {
      requestRevision.current += 1
    }
  }, [kind, revision])

  async function loadCatalog(nextQuery: string): Promise<void> {
    const revision = requestRevision.current + 1
    requestRevision.current = revision
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      const result = await onSearch(nextQuery)
      if (requestRevision.current !== revision) return
      setCatalog(result)
      setActiveQuery(nextQuery)
    } catch (error) {
      if (requestRevision.current !== revision) return
      setCatalogError(errorMessage(error))
    } finally {
      if (requestRevision.current === revision) setCatalogLoading(false)
    }
  }

  async function changeInstallation(pkg: KernelPiDevPackage): Promise<void> {
    const action = pkg.installed ? '卸载' : '安装'
    const warning = kind === 'extension'
      ? pkg.installed
        ? `卸载 Package「${pkg.name}」？其中的 Extension 及其他资源会一并移除。`
        : `安装含 Extension 资源的 Package「${pkg.name}」？第三方 Package 会以当前用户的完整系统权限运行，请先审查源码。`
      : pkg.installed
        ? `从 Pi 用户级 Package 中卸载「${pkg.name}」？`
        : `安装 Package「${pkg.name}」？第三方 Package 会以当前用户的完整系统权限运行，请先审查源码。`
    if (!window.confirm(warning)) return

    setActingPackage(pkg.name)
    setCatalogError(null)
    try {
      if (pkg.installed) await onRemove(`npm:${pkg.name}`)
      else await onInstall(pkg.name)
      await loadCatalog(activeQuery)
    } catch (error) {
      setCatalogError(`${action}失败：${errorMessage(error)}`)
    } finally {
      setActingPackage(null)
    }
  }

  const packageActionPending =
    isWorkbenchAction(pendingAction, 'install-pi-dev-package') ||
    isWorkbenchAction(pendingAction, 'remove-pi-package')
  const catalogLabel = kind === 'extension' ? 'Extension 类型 Package' : 'Package'
  const catalogUrl = kind === 'extension'
    ? 'https://pi.dev/packages?type=extension'
    : 'https://pi.dev/packages'
  const headingId = `settings-pi-dev-${kind}-heading`

  return (
    <section className="settings-group" aria-labelledby={headingId}>
      <div className="settings-group-heading-row">
        <h3
          id={headingId}
          className="settings-group-heading settings-pi-dev-brand"
        >
          <img src={piDevLogoUrl} alt="pi.dev" />
        </h3>
        <button
          className="settings-link-button"
          type="button"
          onClick={() => {
            void onOpenExternal(catalogUrl).catch((error) => {
              setCatalogError(errorMessage(error))
            })
          }}
        >
          打开目录
        </button>
      </div>

      <div className="settings-group-card settings-pi-dev-catalog">
        <form
          className="settings-pi-dev-search"
          onSubmit={(event) => {
            event.preventDefault()
            void loadCatalog(query.trim())
          }}
        >
          <input
            type="search"
            value={query}
            maxLength={100}
            placeholder={`搜索${catalogLabel}名称、说明或作者`}
            aria-label={`搜索 pi.dev ${catalogLabel}`}
            disabled={busy || catalogLoading}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <button type="submit" disabled={busy || catalogLoading}>搜索</button>
        </form>

        {catalogLoading ? (
          <p className="settings-extension-status" role="status">正在读取 pi.dev…</p>
        ) : null}
        {catalogError === null ? null : (
          <p className="settings-extension-error" role="alert">{catalogError}</p>
        )}

        {!catalogLoading && catalog !== null && catalog.packages.length === 0 ? (
          <div className="settings-pi-dev-empty" role="status">没有匹配的{catalogLabel}。</div>
        ) : null}

        {catalog === null ? null : (
          <div className="settings-pi-dev-list" aria-label={`pi.dev ${catalogLabel}目录`}>
            {catalog.packages.map((pkg) => (
              <article className="settings-pi-dev-item" key={pkg.name}>
                <div className="settings-pi-dev-copy">
                  <div className="settings-pi-dev-title">
                    <h4>{pkg.name}</h4>
                    <span>{pkg.downloads}</span>
                  </div>
                  <p>{pkg.description}</p>
                </div>
                <div className="settings-pi-dev-actions">
                  <button
                    type="button"
                    className="settings-link-button"
                    onClick={() => {
                      void onOpenExternal(pkg.detailUrl).catch((error) => {
                        setCatalogError(errorMessage(error))
                      })
                    }}
                  >
                    详情
                  </button>
                  <button
                    type="button"
                    className="settings-extension-remove"
                    data-installed={pkg.installed || undefined}
                    disabled={busy || catalogLoading || packageActionPending}
                    onClick={() => void changeInstallation(pkg)}
                  >
                    {actingPackage === pkg.name
                      ? pkg.installed ? '卸载中…' : '安装中…'
                      : pkg.installed ? '卸载' : '安装'}
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
