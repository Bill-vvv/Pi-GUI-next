import type {
  KernelModelPricing,
  KernelModelPricingFetchResult
} from '../../shared/kernel-contract.ts'

const LITELLM_MODEL_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const PRICING_TIMEOUT_MS = 10_000
const TOKENS_PER_MILLION = 1_000_000

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
type JsonObject = Record<string, unknown>

export async function fetchLiteLlmModelPricing(
  providerId: string,
  modelId: string,
  fetch: Fetch
): Promise<KernelModelPricingFetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS)

  try {
    const response = await fetch(LITELLM_MODEL_PRICING_URL, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`LiteLLM pricing request failed with HTTP ${response.status}.`)
    }

    const value: unknown = await response.json()
    if (!isRecord(value)) throw new Error('LiteLLM pricing response is not a JSON object.')
    const modelKey = resolveModelKey(value, providerId, modelId)
    if (modelKey === null) {
      throw new Error(`LiteLLM pricing does not contain model ${providerId}/${modelId}.`)
    }

    return {
      source: 'litellm',
      modelKey,
      pricing: parsePricing(value[modelKey], modelKey)
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('LiteLLM pricing request timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function resolveModelKey(value: JsonObject, providerId: string, modelId: string): string | null {
  const keys = Object.keys(value)
  const exactModelId = exactKey(keys, modelId)
  if (exactModelId !== null) return exactModelId

  const providerModelId = `${providerId}/${modelId}`
  const exactProviderModelId = exactKey(keys, providerModelId)
  if (exactProviderModelId !== null) return exactProviderModelId

  const suffix = `/${modelId}`.toLowerCase()
  const providerIdLower = providerId.toLowerCase()
  const candidates = keys.filter((key) => key.toLowerCase().endsWith(suffix))
  if (candidates.length === 0) return null
  const providerCandidates = candidates.filter((key) => {
    const pricing = value[key]
    return (
      key.toLowerCase().startsWith(`${providerIdLower}/`) ||
      (
        isRecord(pricing) &&
        typeof pricing.litellm_provider === 'string' &&
        pricing.litellm_provider.toLowerCase() === providerIdLower
      )
    )
  })
  return (providerCandidates.length > 0 ? providerCandidates : candidates).sort()[0] ?? null
}

function exactKey(keys: readonly string[], candidate: string): string | null {
  const candidateLower = candidate.toLowerCase()
  return keys.find((key) => key.toLowerCase() === candidateLower) ?? null
}

function parsePricing(value: unknown, modelKey: string): KernelModelPricing {
  if (!isRecord(value)) throw new Error(`LiteLLM pricing for ${modelKey} is invalid.`)
  return {
    input: perMillion(value.input_cost_per_token, 'input_cost_per_token', modelKey),
    output: perMillion(value.output_cost_per_token, 'output_cost_per_token', modelKey),
    cacheRead: optionalPerMillion(
      value.cache_read_input_token_cost,
      'cache_read_input_token_cost',
      modelKey
    ),
    cacheWrite: optionalPerMillion(
      value.cache_creation_input_token_cost,
      'cache_creation_input_token_cost',
      modelKey
    )
  }
}

function perMillion(value: unknown, field: string, modelKey: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`LiteLLM pricing field ${field} is invalid for ${modelKey}.`)
  }
  return Math.round(value * TOKENS_PER_MILLION * 1e10) / 1e10
}

function optionalPerMillion(value: unknown, field: string, modelKey: string): number {
  return value === undefined ? 0 : perMillion(value, field, modelKey)
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
