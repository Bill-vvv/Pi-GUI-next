import { useState } from 'react'

import { MAGIC_CONTEXT_PACKAGE_NAME } from '../../../../shared/kernel-contract'
import type {
  KernelExtensionSelectionKind,
  KernelInstalledPackage,
  KernelPiDevCatalog,
  KernelPiPackageInstallJob,
  KernelState
} from '../../../../shared/kernel-contract'
import { isWorkbenchAction, type WorkbenchOperation } from '../../workbench-actions'
import { AdaptedExtensionPackageControl } from './AdaptedExtensionPackageControl'
import { PiDevCatalog } from './PiDevCatalog'
import { SettingsPageHeading } from './SettingsPageHeading'
import { useSettingsConfirm } from './SettingsConfirmDialog'

export function ExtensionSettings({
  extensions,
  busy,
  pendingAction,
  extensionActionError,
  packageInstallJobs,
  packageRevision,
  onPackagesChanged,
  onInstallExtension,
  onRemoveExtension,
  onListPiPackages,
  onSearchPiDevExtensions,
  onInstallPiDevPackage,
  onRemovePiPackage,
  onSetMagicContextEnabled,
  onOpenExternal
}: {
  extensions: KernelState['extensions']
  busy: boolean
  pendingAction: WorkbenchOperation | null
  extensionActionError: string | null
  packageInstallJobs: KernelPiPackageInstallJob[]
  packageRevision: number
  onPackagesChanged: () => void
  onInstallExtension: (kind: KernelExtensionSelectionKind) => Promise<void>
  onRemoveExtension: (path: string) => Promise<void>
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onSearchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onRemovePiPackage: (source: string) => Promise<void>
  onSetMagicContextEnabled: (enabled: boolean) => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
}): React.JSX.Element {
  const [removingExtensionPath, setRemovingExtensionPath] = useState<string | null>(null)
  const { confirm, confirmDialog } = useSettingsConfirm()
  const installPiDevPackage = async (name: string): Promise<void> => {
    await onInstallPiDevPackage(name)
    onPackagesChanged()
  }

  return (
    <>
      <SettingsPageHeading
        title="扩展"
        description="安装或卸载后，将在下一次新建或重新打开对话时生效"
      />
      <AdaptedExtensionPackageControl
        heading="Magic Context"
        idPrefix="settings-extensions-magic-context"
        packageName={MAGIC_CONTEXT_PACKAGE_NAME}
        detailUrl="https://github.com/cortexkit/magic-context"
        description="提供后台上下文压缩与跨会话记忆"
        notice={(
          <>
            扩展显示“已开启”只表示扩展已启用，不代表配置或健康状态已验证。
            安装后仍需手动运行 <code>npx @cortexkit/magic-context@latest setup --harness pi</code>；
            新建或重新载入对话后生效。运行态可用 <code>/ctx-status</code>，
            健康检查请运行 <code>npx @cortexkit/magic-context@latest doctor --harness pi</code>。
          </>
        )}
        busy={busy}
        packageInstallJobs={packageInstallJobs}
        onListPiPackages={onListPiPackages}
        onInstallPiDevPackage={installPiDevPackage}
        onSetEnabled={onSetMagicContextEnabled}
        onOpenExternal={onOpenExternal}
      />
      <PiDevCatalog
        kind="extension"
        busy={busy}
        pendingAction={pendingAction}
        packageInstallJobs={packageInstallJobs}
        revision={packageRevision}
        onSearch={onSearchPiDevExtensions}
        onInstall={installPiDevPackage}
        onRemove={async (source) => {
          await onRemovePiPackage(source)
          onPackagesChanged()
        }}
        onOpenExternal={onOpenExternal}
      />
      <section className="settings-group" aria-labelledby="settings-local-extensions-heading">
        <h3 id="settings-local-extensions-heading" className="settings-group-heading">本地路径</h3>
        <div className="settings-resource-list">
          <article className="settings-resource-row">
            <div className="settings-resource-copy">
              <h3>安装本地扩展</h3>
              <p>
                第三方扩展拥有完整系统权限。选择后，其路径会写入 Pi 用户设置的 extensions；
                卸载只移除配置，不删除扩展源码
              </p>
            </div>
            <div className="settings-resource-actions settings-extension-install-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => void onInstallExtension('file').catch(() => undefined)}
              >
                选择文件
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onInstallExtension('directory').catch(() => undefined)}
              >
                选择目录
              </button>
            </div>
          </article>
        </div>
        {isWorkbenchAction(pendingAction, 'install-extension') ||
        isWorkbenchAction(pendingAction, 'remove-extension') ? (
          <p className="settings-feedback" role="status" aria-live="polite">
            {isWorkbenchAction(pendingAction, 'install-extension') ? '正在安装…' : '正在卸载…'}
          </p>
        ) : null}
        {extensionActionError === null ? null : (
          <p className="settings-feedback settings-feedback-error" role="alert">{extensionActionError}</p>
        )}
        {extensions.length === 0 ? (
          <div className="settings-empty-state" role="status">
            <h3>暂无本地扩展</h3>
          </div>
        ) : (
          <div className="settings-resource-list">
            {extensions.map((extension) => (
              <article className="settings-resource-row" key={extension.path}>
                <div className="settings-resource-copy">
                  <h3>{extension.name}</h3>
                  <code>{extension.path}</code>
                </div>
                <div className="settings-resource-actions">
                  <button
                    className="settings-extension-remove"
                    type="button"
                    aria-label={`卸载扩展 ${extension.name}`}
                    data-tooltip="仅从 Pi 用户设置中移除此路径，不删除扩展源码。"
                    disabled={busy}
                    onClick={() => {
                      void confirm({
                        title: `卸载「${extension.name}」？`,
                        description: '只从 Pi 用户设置中移除此路径，源码文件不会被删除。',
                        confirmLabel: '卸载',
                        danger: true
                      }).then((confirmed) => {
                        if (!confirmed) return
                        setRemovingExtensionPath(extension.path)
                        return onRemoveExtension(extension.path)
                          .catch(() => undefined)
                          .finally(() => setRemovingExtensionPath(null))
                      })
                    }}
                  >
                    {removingExtensionPath === extension.path ? '卸载中…' : '卸载'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      {confirmDialog}
    </>
  )
}
