import { useEffect, useRef, useState } from 'react'


import type {
  AppearanceSettings as AppearanceSettingsValue,
  GeneralSettings as GeneralSettingsValue,
  KernelExtensionSelectionKind,
  KernelInstalledPackage,
  KernelModelPricingFetchResult,
  KernelPiPackageInstallJob,
  KernelPiDevCatalog,
  KernelProviderAuthEvent,
  KernelProviderAuthType,
  KernelProviderConfig,
  KernelProviderCredential,
  KernelProviderInput,
  KernelProviderTestResult,
  KernelState,
  KernelSubagentDefinition,
  KernelSubagentEditableScope,
  KernelSubagentDefinitionInput,
  SessionNamingSettings,
  SubagentSettings as SubagentSettingsValue,
  ShortcutSettings
} from '../../../../shared/kernel-contract'
import type {
  DesktopHostAccessStatus,
  RemoteAccessStatus,
  RemotePairingCode,
  TailscaleRemoteStatus
} from '../../../../shared/remote-admin-contract'
import { type ToolDisplayDensity } from '../../tool-display-density'
import type { WorkbenchOperation } from '../../workbench-actions'
import { AppearanceSettings } from './AppearanceSettings'
import { CredentialsPanel } from './CredentialsPanel'
import { ExtensionSettings } from './ExtensionSettings'
import { GeneralSettings } from './GeneralSettings'
import { ModelSettings } from './ModelSettings'
import { PackageSettings } from './PackageSettings'
import { ProviderSettings } from './ProviderSettings'
import { RemoteSettings } from './RemoteSettings'
import type { SettingsSection } from './SettingsNavigation'
import { ShortcutSettingsPanel } from './ShortcutSettingsPanel'
import { SkillSettings } from './SkillSettings'
import { SubagentSettings } from './SubagentSettings'
import { useSettingsJump } from './settings-jump'
import type { SettingsJumpTarget } from './settings-workspace'

type SettingsPanelProps = {
  state: KernelState
  clientOnly?: boolean
  environmentPanel?: React.ReactNode
  busy: boolean
  section: SettingsSection
  /** Search result to reveal in the current section. */
  jumpTarget?: SettingsJumpTarget | null
  pendingAction: WorkbenchOperation | null
  extensionActionError: string | null
  actionError: string | null
  systemFonts: string[] | null
  systemFontsError: string | null
  onInstallExtension: (kind: KernelExtensionSelectionKind) => Promise<void>
  onRemoveExtension: (path: string) => Promise<void>
  onSearchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  onSearchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  packageInstallJobs: KernelPiPackageInstallJob[]
  onInstallPiDevPackage: (name: string) => Promise<void>
  onRemovePiPackage: (source: string) => Promise<void>
  onUpdatePiPackage: (source: string) => Promise<void>
  onUpdatePiPackages: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  onCreateSkill: (prompt: string) => Promise<void>
  onListProviders: () => Promise<KernelProviderConfig[]>
  onSaveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  onRemoveProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  onTestProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
  onFetchModelPricing: (
    providerId: string,
    modelIds: string[]
  ) => Promise<KernelModelPricingFetchResult>
  onListProviderCredentials: () => Promise<KernelProviderCredential[]>
  onLoginProvider: (
    providerId: string,
    authType: KernelProviderAuthType
  ) => Promise<KernelProviderCredential[]>
  onSubmitProviderAuthPrompt: (
    operationId: string,
    promptId: string,
    value: string
  ) => Promise<void>
  onCancelProviderLogin: (operationId: string) => Promise<void>
  onLogoutProvider: (providerId: string) => Promise<KernelProviderCredential[]>
  onSubscribeProviderAuth: (
    listener: (event: KernelProviderAuthEvent) => void
  ) => () => void
  onGetRemoteAccessStatus: () => Promise<RemoteAccessStatus>
  onCreateRemotePairingCode: () => Promise<RemotePairingCode>
  onRevokeRemoteDevice: () => Promise<RemoteAccessStatus>
  onGetTailscaleStatus: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleFunnel: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleServe: () => Promise<TailscaleRemoteStatus>
  onDisableTailscale: () => Promise<TailscaleRemoteStatus>
  onGetDesktopHostStatus: () => Promise<DesktopHostAccessStatus>
  onCreateDesktopHostPairingCode: () => Promise<RemotePairingCode>
  onRevokeDesktopHostDevice: (deviceId: string) => Promise<DesktopHostAccessStatus>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettingsValue) => Promise<void>
  onSetSubagentEnabled: (enabled: boolean) => Promise<void>
  onSetMagicContextEnabled: (enabled: boolean) => Promise<void>
  onListSubagentDefinitions: () => Promise<KernelSubagentDefinition[]>
  onSaveSubagentDefinition: (
    definition: KernelSubagentDefinitionInput
  ) => Promise<KernelSubagentDefinition[]>
  onSetSubagentDefinitionEnabled: (
    id: string,
    scope: KernelSubagentEditableScope,
    enabled: boolean
  ) => Promise<KernelSubagentDefinition[]>
  onRemoveSubagentDefinition: (id: string) => Promise<KernelSubagentDefinition[]>
  onSetSubagent: (settings: SubagentSettingsValue) => Promise<void>
  onSetAppearance: (settings: AppearanceSettingsValue) => Promise<void>
  onSetShortcuts: (settings: ShortcutSettings) => Promise<void>
  onShortcutRecordingChange: (recording: boolean) => void
  toolDisplayDensity: ToolDisplayDensity
  onSetToolDisplayDensity: (density: ToolDisplayDensity) => void
  hiddenModelKeys: ReadonlySet<string>
  onSetModelsVisible: (
    models: ReadonlyArray<{ provider: string; modelId: string }>,
    visible: boolean
  ) => void
  onDirtyChange: (dirty: boolean) => void
  onActiveOperationChange: (active: boolean) => void
}

export function SettingsPanel({
  state,
  clientOnly = false,
  environmentPanel,
  busy,
  section,
  jumpTarget = null,
  pendingAction,
  extensionActionError,
  actionError,
  systemFonts,
  systemFontsError,
  onInstallExtension,
  onRemoveExtension,
  onSearchPiDevExtensions,
  onSearchPiDevPackages,
  onListPiPackages,
  packageInstallJobs,
  onInstallPiDevPackage,
  onRemovePiPackage,
  onUpdatePiPackage,
  onUpdatePiPackages,
  onOpenExternal,
  onCreateSkill,
  onListProviders,
  onSaveProvider,
  onRemoveProvider,
  onTestProvider,
  onFetchModelPricing,
  onListProviderCredentials,
  onLoginProvider,
  onSubmitProviderAuthPrompt,
  onCancelProviderLogin,
  onLogoutProvider,
  onSubscribeProviderAuth,
  onGetRemoteAccessStatus,
  onCreateRemotePairingCode,
  onRevokeRemoteDevice,
  onGetTailscaleStatus,
  onEnableTailscaleFunnel,
  onEnableTailscaleServe,
  onDisableTailscale,
  onGetDesktopHostStatus,
  onCreateDesktopHostPairingCode,
  onRevokeDesktopHostDevice,
  onSetModel,
  onSetSessionNaming,
  onSetGeneral,
  onSetSubagentEnabled,
  onSetMagicContextEnabled,
  onListSubagentDefinitions,
  onSaveSubagentDefinition,
  onSetSubagentDefinitionEnabled,
  onRemoveSubagentDefinition,
  onSetSubagent,
  onSetAppearance,
  onSetShortcuts,
  onShortcutRecordingChange,
  toolDisplayDensity,
  onSetToolDisplayDensity,
  hiddenModelKeys,
  onSetModelsVisible,
  onDirtyChange,
  onActiveOperationChange
}: SettingsPanelProps): React.JSX.Element {
  const [packageRevision, setPackageRevision] = useState(0)
  const handledPackageInstallJobs = useRef(new Set<string>())
  const packageInstallActive = packageInstallJobs.some((job) =>
    job.status === 'queued' || job.status === 'running'
  )
  const bumpPackageRevision = (): void => setPackageRevision((revision) => revision + 1)
  const contentRef = useRef<HTMLDivElement>(null)
  useSettingsJump(contentRef, jumpTarget)

  // Package and extension changes made on this visit are saved to Pi's user
  // settings but never reload open Runtimes; the affected pages say so.
  const [reloadPending, setReloadPending] = useState(false)
  const activePackageInstallJobs = useRef(new Set<string>())
  const initialExtensions = useRef(state.extensions)
  const markReloadPending = <Args extends unknown[]>(
    action: (...args: Args) => Promise<void>
  ) => async (...args: Args): Promise<void> => {
    await action(...args)
    setReloadPending(true)
  }
  useEffect(() => {
    if (state.extensions !== initialExtensions.current) setReloadPending(true)
  }, [state.extensions])

  useEffect(() => {
    for (const job of packageInstallJobs) {
      if (job.status === 'queued' || job.status === 'running') {
        activePackageInstallJobs.current.add(job.id)
        continue
      }
      if (handledPackageInstallJobs.current.has(job.id)) continue
      handledPackageInstallJobs.current.add(job.id)
      setPackageRevision((revision) => revision + 1)
      // Only installs seen queued or running on this visit count as changes made here.
      if (job.status === 'succeeded' && activePackageInstallJobs.current.has(job.id)) setReloadPending(true)
    }
  }, [packageInstallJobs])

  return (
    <section className="settings-screen" aria-label="设置">
      <div className="settings-content" ref={contentRef}>
        {actionError === null ? null : (
          <p className="settings-feedback settings-feedback-error" role="alert">{actionError}</p>
        )}
        {section === 'general' ? (
          <GeneralSettings
            general={state.general}
            sessionNaming={state.sessionNaming}
            availableModels={state.availableModels}
            clientOnly={clientOnly}
            environmentPanel={environmentPanel}
            busy={busy}
            onSetGeneral={onSetGeneral}
            onSetSessionNaming={onSetSessionNaming}
          />
        ) : null}

        {section === 'appearance' ? (
          <AppearanceSettings
            appearance={state.appearance}
            busy={busy}
            systemFonts={systemFonts}
            systemFontsError={systemFontsError}
            toolDisplayDensity={toolDisplayDensity}
            onSetAppearance={onSetAppearance}
            onSetToolDisplayDensity={onSetToolDisplayDensity}
          />
        ) : null}

        {section === 'shortcuts' ? (
          <ShortcutSettingsPanel
            settings={state.shortcuts}
            onSave={onSetShortcuts}
            onRecordingChange={onShortcutRecordingChange}
          />
        ) : null}

        <ModelSettings
          active={section === 'models'}
          availableModels={state.availableModels}
          currentModel={state.session.model}
          runtimeStatus={state.runtime.status}
          busy={busy}
          hiddenModelKeys={hiddenModelKeys}
          onSetModel={onSetModel}
          onSetModelsVisible={onSetModelsVisible}
          credentials={(
            <CredentialsPanel
              busy={busy}
              onListProviderCredentials={onListProviderCredentials}
              onLoginProvider={onLoginProvider}
              onSubmitProviderAuthPrompt={onSubmitProviderAuthPrompt}
              onCancelProviderLogin={onCancelProviderLogin}
              onLogoutProvider={onLogoutProvider}
              onSubscribeProviderAuth={onSubscribeProviderAuth}
              onOpenExternal={onOpenExternal}
              onActiveOperationChange={onActiveOperationChange}
            />
          )}
          customProviders={(
            <ProviderSettings
              busy={busy}
              tokenCountFormat={state.appearance.tokenCountFormat}
              onListProviders={onListProviders}
              onSaveProvider={onSaveProvider}
              onRemoveProvider={onRemoveProvider}
              onTestProvider={onTestProvider}
              onFetchModelPricing={onFetchModelPricing}
              onDirtyChange={onDirtyChange}
            />
          )}
        />

        {section === 'remote' ? (
          <RemoteSettings
            busy={busy}
            onGetRemoteAccessStatus={onGetRemoteAccessStatus}
            onCreateRemotePairingCode={onCreateRemotePairingCode}
            onRevokeRemoteDevice={onRevokeRemoteDevice}
            onGetTailscaleStatus={onGetTailscaleStatus}
            onEnableTailscaleFunnel={onEnableTailscaleFunnel}
            onEnableTailscaleServe={onEnableTailscaleServe}
            onDisableTailscale={onDisableTailscale}
            onGetDesktopHostStatus={onGetDesktopHostStatus}
            onCreateDesktopHostPairingCode={onCreateDesktopHostPairingCode}
            onRevokeDesktopHostDevice={onRevokeDesktopHostDevice}
            onOpenExternal={onOpenExternal}
          />
        ) : null}

        {section === 'subagent' ? (
          <SubagentSettings
            settings={state.subagent}
            activeProjectKey={state.activeProjectKey}
            availableModels={state.availableModels}
            busy={busy}
            packageBusy={busy || packageInstallActive}
            reloadPending={reloadPending}
            packageInstallJobs={packageInstallJobs}
            onListPiPackages={onListPiPackages}
            onInstallPiDevPackage={async (name) => {
              await onInstallPiDevPackage(name)
              bumpPackageRevision()
            }}
            onSetSubagentEnabled={markReloadPending(onSetSubagentEnabled)}
            onOpenExternal={onOpenExternal}
            onListSubagentDefinitions={onListSubagentDefinitions}
            onSaveSubagentDefinition={onSaveSubagentDefinition}
            onSetSubagentDefinitionEnabled={onSetSubagentDefinitionEnabled}
            onRemoveSubagentDefinition={onRemoveSubagentDefinition}
            onSetSubagent={onSetSubagent}
            onDirtyChange={onDirtyChange}
          />
        ) : null}

        {section === 'packages' ? (
          <PackageSettings
            busy={busy || packageInstallActive}
            pendingAction={pendingAction}
            packageInstallJobs={packageInstallJobs}
            packageRevision={packageRevision}
            reloadPending={reloadPending}
            onPackagesChanged={bumpPackageRevision}
            onListPiPackages={onListPiPackages}
            onSearchPiDevPackages={onSearchPiDevPackages}
            onInstallPiDevPackage={onInstallPiDevPackage}
            onRemovePiPackage={markReloadPending(onRemovePiPackage)}
            onUpdatePiPackage={markReloadPending(onUpdatePiPackage)}
            onUpdatePiPackages={markReloadPending(onUpdatePiPackages)}
            onOpenExternal={onOpenExternal}
          />
        ) : null}

        {section === 'extensions' ? (
          <ExtensionSettings
            extensions={state.extensions}
            busy={busy || packageInstallActive}
            pendingAction={pendingAction}
            extensionActionError={extensionActionError}
            packageInstallJobs={packageInstallJobs}
            packageRevision={packageRevision}
            reloadPending={reloadPending}
            onPackagesChanged={bumpPackageRevision}
            onInstallExtension={onInstallExtension}
            onRemoveExtension={onRemoveExtension}
            onListPiPackages={onListPiPackages}
            onSearchPiDevExtensions={onSearchPiDevExtensions}
            onInstallPiDevPackage={onInstallPiDevPackage}
            onRemovePiPackage={markReloadPending(onRemovePiPackage)}
            onSetMagicContextEnabled={markReloadPending(onSetMagicContextEnabled)}
            onOpenExternal={onOpenExternal}
          />
        ) : null}

        <SkillSettings
          active={section === 'skills'}
          commands={state.commands}
          activeProjectKey={state.activeProjectKey}
          runtimeStatus={state.runtime.status}
          busy={busy}
          onCreateSkill={onCreateSkill}
        />
      </div>
    </section>
  )
}
