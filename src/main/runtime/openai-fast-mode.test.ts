import assert from 'node:assert/strict'
import test from 'node:test'

import type { PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'
import {
  OPENAI_FAST_MODE_ENTRY_TYPE,
  openAiFastModeFromSessionEntries
} from './openai-fast-mode.ts'

function entries(values: unknown[]): PiRpcSessionEntry[] {
  return values as PiRpcSessionEntry[]
}

test('Session Fast mode projection follows the newest active-branch entry', () => {
  assert.equal(openAiFastModeFromSessionEntries(entries([])), false)
  assert.equal(openAiFastModeFromSessionEntries(entries([
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: true } },
    { type: 'custom', customType: 'other-state', data: { enabled: false } }
  ])), true)
  assert.equal(openAiFastModeFromSessionEntries(entries([
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: true } },
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: false } }
  ])), false)
})

test('Session Fast mode projection rejects malformed owned metadata as unavailable', () => {
  assert.equal(openAiFastModeFromSessionEntries(entries([
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: 'yes' } }
  ])), false)
})
