import type {
  KernelInstalledPackage,
  KernelPiDevCatalog,
  KernelPiPackageInstallJob
} from '../../../../shared/kernel-contract'
import type { WorkbenchOperation } from '../../workbench-actions'
import { InstalledPackages } from './InstalledPackages'
import { PiDevCatalog } from './PiDevCatalog'
import { SettingsPageHeading } from './SettingsPageHeading'
import { PLUGIN_RELOAD_PENDING_STATUS } from './plugin-reload-status'

export function PackageSettings({
  busy,
  pendingAction,
  packageInstallJobs,
  packageRevision,
  reloadPending,
  onPackagesChanged,
  onListPiPackages,
  onSearchPiDevPackages,
  onInstallPiDevPackage,
  onRemovePiPackage,
  onUpdatePiPackage,
  onUpdatePiPackages,
  onOpenExternal
}: {
  busy: boolean
  pendingAction: WorkbenchOperation | null
  packageInstallJobs: KernelPiPackageInstallJob[]
  packageRevision: number
  /** Packages changed on this settings visit; open Runtimes still use what they loaded. */
  reloadPending: boolean
  onPackagesChanged: () => void
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onSearchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onRemovePiPackage: (source: string) => Promise<void>
  onUpdatePiPackage: (source: string) => Promise<void>
  onUpdatePiPackages: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
}): React.JSX.Element {
  return (
    <>
      <SettingsPageHeading
        title="插件"
        description="即 Pi Package，可包含扩展、技能与提示模板。安装或卸载后，将在下一次新建或重新打开对话时生效"
        status={reloadPending ? PLUGIN_RELOAD_PENDING_STATUS : null}
      />
      <InstalledPackages
        busy={busy}
        pendingAction={pendingAction}
        revision={packageRevision}
        onList={onListPiPackages}
        onRemove={async (source) => {
          await onRemovePiPackage(source)
          onPackagesChanged()
        }}
        onUpdate={async (source) => {
          await onUpdatePiPackage(source)
          onPackagesChanged()
        }}
        onUpdateAll={async () => {
          await onUpdatePiPackages()
          onPackagesChanged()
        }}
      />
      <PiDevCatalog
        kind="package"
        busy={busy}
        pendingAction={pendingAction}
        packageInstallJobs={packageInstallJobs}
        revision={packageRevision}
        onSearch={onSearchPiDevPackages}
        onInstall={async (name) => {
          await onInstallPiDevPackage(name)
          onPackagesChanged()
        }}
        onRemove={async (source) => {
          await onRemovePiPackage(source)
          onPackagesChanged()
        }}
        onOpenExternal={onOpenExternal}
      />
    </>
  )
}
