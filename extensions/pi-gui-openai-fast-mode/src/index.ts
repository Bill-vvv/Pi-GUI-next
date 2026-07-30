import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import {
  OPENAI_FAST_MODE_COMMAND_NAME,
  OPENAI_FAST_MODE_ENTRY_TYPE,
  buildOpenAiFastModeEntryData,
  parseOpenAiFastModeCommandArgs,
  parseOpenAiFastModeEntryData
} from './protocol.mjs'

const OPENAI_PROVIDER_IDS = new Set(['openai', 'openai-codex'])
const CPA_PROVIDER_ID = 'vvqq-cpa'

type ProviderPayload = Record<string, unknown>

function isProviderPayload(value: unknown): value is ProviderPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function supportsOpenAiFastMode(
  provider: string | undefined,
  modelId: string | undefined
): boolean {
  if (provider === undefined) return false
  if (OPENAI_PROVIDER_IDS.has(provider)) return true
  return provider === CPA_PROVIDER_ID && modelId?.startsWith('gpt-') === true
}

export function applyOpenAiFastMode(
  payload: unknown,
  provider: string | undefined,
  modelId: string | undefined,
  enabled: boolean
): unknown {
  if (!enabled || !supportsOpenAiFastMode(provider, modelId)) return payload
  if (!isProviderPayload(payload)) return payload
  return { ...payload, service_tier: 'priority' }
}

export function openAiFastModeFromSessionBranch(ctx: ExtensionContext): boolean {
  const branch = ctx.sessionManager.getBranch()
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry?.type !== 'custom' || entry.customType !== OPENAI_FAST_MODE_ENTRY_TYPE) continue
    return parseOpenAiFastModeEntryData(entry.data) ?? false
  }
  return false
}

export default function openAiFastModeExtension(pi: ExtensionAPI): void {
  let enabled = false

  const restoreFromSession = (ctx: ExtensionContext): void => {
    enabled = openAiFastModeFromSessionBranch(ctx)
  }

  pi.registerCommand(OPENAI_FAST_MODE_COMMAND_NAME, {
    description: 'Pi GUI internal OpenAI Fast mode control',
    handler: (args) => {
      const nextEnabled = parseOpenAiFastModeCommandArgs(args)
      if (nextEnabled === null) throw new Error('OpenAI Fast mode requires "on" or "off".')
      if (nextEnabled === enabled) return
      enabled = nextEnabled
      pi.appendEntry(
        OPENAI_FAST_MODE_ENTRY_TYPE,
        buildOpenAiFastModeEntryData(enabled)
      )
    }
  })

  pi.on('session_start', (_event, ctx) => restoreFromSession(ctx))
  pi.on('session_tree', (_event, ctx) => restoreFromSession(ctx))

  pi.on('before_provider_request', (event, ctx) => applyOpenAiFastMode(
    event.payload,
    ctx.model?.provider,
    ctx.model?.id,
    enabled
  ))
}
