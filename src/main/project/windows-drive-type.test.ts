import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseWindowsDriveTypeOutput,
  WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE
} from './windows-drive-type.ts'

test('Windows drive type output accepts only one documented enum value', () => {
  assert.equal(parseWindowsDriveTypeOutput('3\r\n', 'C:\\'), 3)
  assert.equal(parseWindowsDriveTypeOutput('4', 'Z:\\'), 4)

  for (const output of ['', '7', '33', 'Fixed', '3 4']) {
    assert.throws(
      () => parseWindowsDriveTypeOutput(output, 'C:\\'),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE)
        return true
      }
    )
  }
})
