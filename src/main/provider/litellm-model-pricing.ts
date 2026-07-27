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
  modelIds: string[],
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
    const matches: KernelModelPricingFetchResult['matches'] = []
    const missingModelIds: string[] = []
    for (const modelId of modelIds) {
      const match = resolvePricingMatch(value, providerId, modelId)
      if (match === null) {
        missingModelIds.push(modelId)
        continue
      }
      matches.push({ modelId, ...match })
    }

    return {
      source: 'litellm',
      matches,
      missingModelIds
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('LiteLLM pricing request timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function resolvePricingMatch(
  value: JsonObject,
  providerId: string,
  modelId: string
): { modelKey: string; pricing: KernelModelPricing } | null {
  for (const modelKey of pricingCandidateKeys(value, providerId, modelId)) {
    const pricing = tryParsePricing(value[modelKey], modelKey)
    if (pricing !== null) return { modelKey, pricing }
  }
  return null
}

function pricingCandidateKeys(value: JsonObject, providerId: string, modelId: string): string[] {
  const keys = Object.keys(value)
  const providerIdLower = providerId.toLowerCase()
  const exactCandidates = [
    exactKey(keys, modelId),
    exactKey(keys, `${providerId}/${modelId}`)
  ].filter((key): key is string => key !== null)
  const suffix = `/${modelId}`.toLowerCase()
  const suffixCandidates = keys.filter((key) => key.toLowerCase().endsWith(suffix))
  const providerCandidates: string[] = []
  const otherCandidates: string[] = []

  for (const key of suffixCandidates) {
    const pricing = value[key]
    const matchesProvider =
      key.toLowerCase().startsWith(`${providerIdLower}/`) ||
      (
        isRecord(pricing) &&
        typeof pricing.litellm_provider === 'string' &&
        pricing.litellm_provider.toLowerCase() === providerIdLower
      )
    if (matchesProvider) providerCandidates.push(key)
    else otherCandidates.push(key)
  }

  return [...new Set([
    ...exactCandidates,
    ...providerCandidates.sort(),
    ...otherCandidates.sort()
  ])]
}

function exactKey(keys: readonly string[], candidate: string): string | null {
  const candidateLower = candidate.toLowerCase()
  return keys.find((key) => key.toLowerCase() === candidateLower) ?? null
}

function tryParsePricing(value: unknown, modelKey: string): KernelModelPricing | null {
  try {
    return parsePricing(value, modelKey)
  } catch {
    return null
  }
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
