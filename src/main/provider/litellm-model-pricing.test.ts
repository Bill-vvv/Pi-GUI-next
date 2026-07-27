import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchLiteLlmModelPricing } from './litellm-model-pricing.ts'

test('fetches and converts LiteLLM prices to USD per million tokens', async () => {
  const result = await fetchLiteLlmModelPricing(
    'openai',
    ['gpt-priced', 'provider-priced'],
    catalogFetch({
      'gpt-priced': {
        litellm_provider: 'openai',
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000006,
        cache_read_input_token_cost: 0.0000001,
        cache_creation_input_token_cost: 0.00000125
      },
      'openai/provider-priced': {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001
      }
    })
  )

  assert.deepEqual(result, {
    source: 'litellm',
    matches: [
      {
        modelId: 'gpt-priced',
        modelKey: 'gpt-priced',
        pricing: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 }
      },
      {
        modelId: 'provider-priced',
        modelKey: 'openai/provider-priced',
        pricing: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }
      }
    ],
    missingModelIds: []
  })
})

test('keeps valid batch matches when another LiteLLM model has no usable price', async () => {
  const result = await fetchLiteLlmModelPricing(
    'custom-proxy',
    ['priced', 'catalog-only', 'missing'],
    catalogFetch({
      priced: {
        input_cost_per_token: 0.0000025,
        output_cost_per_token: 0.000015
      },
      'chatgpt/catalog-only': {
        litellm_provider: 'chatgpt',
        mode: 'responses'
      }
    })
  )

  assert.deepEqual(result, {
    source: 'litellm',
    matches: [{
      modelId: 'priced',
      modelKey: 'priced',
      pricing: { input: 2.5, output: 15, cacheRead: 0, cacheWrite: 0 }
    }],
    missingModelIds: ['catalog-only', 'missing']
  })
})

test('falls through an unpriced exact entry to a priced provider candidate', async () => {
  const result = await fetchLiteLlmModelPricing(
    'openai',
    ['shared-model'],
    catalogFetch({
      'shared-model': {
        litellm_provider: 'other-provider'
      },
      'openai/shared-model': {
        litellm_provider: 'openai',
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000012
      }
    })
  )

  assert.equal(result.matches[0]?.modelKey, 'openai/shared-model')
  assert.deepEqual(result.matches[0]?.pricing, {
    input: 3,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0
  })
  assert.deepEqual(result.missingModelIds, [])
})

function catalogFetch(catalog: Record<string, unknown>) {
  return async (): Promise<Response> => new Response(JSON.stringify(catalog), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
