import assert from 'node:assert/strict'
import test from 'node:test'

import { SharedPiProcessEnvironment } from './shared-pi-process-environment.ts'

const TEST_KEY = 'PI_GUI_SHARED_ENV_TEST'

test('scoped Pi environment isolates concurrent async Session views and writes', async () => {
  const previous = process.env[TEST_KEY]
  process.env[TEST_KEY] = 'ambient'
  const environment = new SharedPiProcessEnvironment()
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })

  try {
    const first = environment.run({ [TEST_KEY]: 'first' }, async () => {
      assert.equal(process.env[TEST_KEY], 'first')
      process.env[TEST_KEY] = 'first-updated'
      await firstGate
      assert.equal(process.env[TEST_KEY], 'first-updated')
      return process.env[TEST_KEY]
    })
    const second = environment.run({ [TEST_KEY]: 'second' }, async () => {
      assert.equal(process.env[TEST_KEY], 'second')
      delete process.env[TEST_KEY]
      assert.equal(TEST_KEY in process.env, false)
      assert.equal(Object.keys(process.env).includes(TEST_KEY), false)
      await secondGate
      assert.equal(process.env[TEST_KEY], undefined)
      return process.env[TEST_KEY]
    })

    assert.equal(process.env[TEST_KEY], 'ambient')
    releaseSecond()
    releaseFirst()
    assert.deepEqual(await Promise.all([first, second]), ['first-updated', undefined])
    assert.equal(process.env[TEST_KEY], 'ambient')
  } finally {
    environment.dispose()
    if (previous === undefined) delete process.env[TEST_KEY]
    else process.env[TEST_KEY] = previous
  }
})

test('scoped Pi environment restores the original process.env object after the final owner', () => {
  const original = process.env
  const first = new SharedPiProcessEnvironment()
  const proxy = process.env
  const second = new SharedPiProcessEnvironment()

  assert.notEqual(proxy, original)
  assert.equal(process.env, proxy)
  first.dispose()
  assert.equal(process.env, proxy)
  second.dispose()
  assert.equal(process.env, original)
})
