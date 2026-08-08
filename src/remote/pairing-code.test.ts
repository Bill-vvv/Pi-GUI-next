import assert from 'node:assert/strict'
import { test } from 'node:test'

import { REMOTE_PAIRING_CODE_LENGTH } from '../shared/remote-contract.ts'
import {
  isCompletePairingCode,
  normalizePairingCodeInput
} from './pairing-code.ts'

test('normalizePairingCodeInput keeps only digits up to the fixed length', () => {
  assert.equal(normalizePairingCodeInput('12a3b4'), '1234')
  assert.equal(normalizePairingCodeInput(' 98-76 54 '), '987654')
  assert.equal(normalizePairingCodeInput('1234567890'), '123456'.slice(0, REMOTE_PAIRING_CODE_LENGTH))
  assert.equal(normalizePairingCodeInput(''), '')
})

test('isCompletePairingCode requires exactly six digits', () => {
  assert.equal(isCompletePairingCode('123456'), true)
  assert.equal(isCompletePairingCode('12345'), false)
  assert.equal(isCompletePairingCode('1234567'), false)
  assert.equal(isCompletePairingCode('12a456'), false)
})
