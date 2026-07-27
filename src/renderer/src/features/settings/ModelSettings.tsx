import { useEffect, useState } from 'react'

import type { KernelModelState, RuntimeStatus } from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'

type ModelSettingsProps = {
  active: boolean
  availableModels: KernelModelState[]
  currentModel: KernelModelState | null
  runtimeStatus: RuntimeStatus
  busy: boolean
  onSetModel: (provider: string, modelId: string) => Promise<void>
}

export function ModelSettings({
  active,
  availableModels,
  currentModel,
  runtimeStatus,
  busy,
  onSetModel
}: ModelSettingsProps): React.JSX.Element | null {
  const [selectedProvider, setSelectedProvider] = useState(
    currentModel?.provider ?? availableModels[0]?.provider ?? ''
  )
  const providers = [...new Set(availableModels.map((model) => model.provider))]
  const currentProviderAvailable = currentModel === null || providers.includes(currentModel.provider)
  const providerValue = providers.includes(selectedProvider) ||
    currentModel?.provider === selectedProvider
    ? selectedProvider
    : providers[0] ?? ''
  const providerModels = availableModels.filter((model) => model.provider === providerValue)
  const selectedCurrentModel = currentModel?.provider === providerValue ? currentModel : null
  const selectedCurrentModelAvailable = selectedCurrentModel === null || providerModels.some(
    (model) => model.id === selectedCurrentModel.id
  )
  const activeModelValue = selectedCurrentModel !== null
    ? selectedCurrentModel.id
    : ''
  const canSetModel = !busy && runtimeStatus === 'ready' && providers.length > 0

  useEffect(() => {
    if (currentModel !== null) setSelectedProvider(currentModel.provider)
  }, [currentModel?.provider])

  if (!active) return null

  return (
    <>
      <div className="settings-section-heading">
        <h2>模型</h2>
      </div>

      <section
        className="settings-group settings-group-inline"
        aria-labelledby="settings-conversation-model"
      >
        <h3 id="settings-conversation-model" className="settings-group-heading">对话模型</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>Provider</h4>
            </div>
            <div className="settings-row-control">
              <Select
                id="conversation-model-provider"
                value={providerValue}
                groups={[{
                  options: [
                    ...(!currentProviderAvailable && currentModel !== null
                      ? [{
                          value: currentModel.provider,
                          label: `${currentModel.provider}（当前不可用）`,
                          disabled: true
                        }]
                      : []),
                    ...providers.map((provider) => ({ value: provider, label: provider }))
                  ]
                }]}
                disabled={!canSetModel}
                onValueChange={setSelectedProvider}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>Model</h4>
            </div>
            <div className="settings-row-control">
              <Select
                id="conversation-model"
                value={activeModelValue}
                groups={[{
                  options: [
                    ...(!selectedCurrentModelAvailable && selectedCurrentModel !== null
                      ? [{
                          value: selectedCurrentModel.id,
                          label: `${
                            selectedCurrentModel.name === selectedCurrentModel.id
                              ? selectedCurrentModel.name
                              : `${selectedCurrentModel.name} · ${selectedCurrentModel.id}`
                          }（当前不可用）`,
                          disabled: true
                        }]
                      : []),
                    ...providerModels.map((model) => ({
                      value: model.id,
                      label: model.name === model.id ? model.name : `${model.name} · ${model.id}`
                    }))
                  ]
                }]}
                disabled={!canSetModel || providerModels.length === 0}
                onValueChange={(modelId) => {
                  void onSetModel(providerValue, modelId).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
