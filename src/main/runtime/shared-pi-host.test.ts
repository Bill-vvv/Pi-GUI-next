import assert from 'node:assert/strict'
import test from 'node:test'

import type { PiRpcExtensionInventory } from '../pi-rpc/pi-rpc-client.ts'
import type { RuntimeCommand, RuntimeCommandResult } from './runtime-host.ts'
import {
  SharedPiHost,
  type SharedPiRuntimeOptions
} from './shared-pi-host.ts'
import type {
  SharedPiAgentSessionCallbacks,
  SharedPiSessionDriver,
  SharedPiSessionFactory
} from './shared-pi-agent-session.ts'

const EMPTY_INVENTORY: PiRpcExtensionInventory = {
  protocolVersion: 1,
  complete: true,
  loading: 'eager_complete',
  extensions: [],
  loadErrorCount: 0
}

class FakeSessionDriver implements SharedPiSessionDriver {
  readonly sessionFile: string
  readonly callbacks: SharedPiAgentSessionCallbacks
  disposeCalls = 0
  disposeFailuresRemaining = 0
  isStreaming = false

  constructor(sessionFile: string, callbacks: SharedPiAgentSessionCallbacks) {
    this.sessionFile = sessionFile
    this.callbacks = callbacks
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === 'get_messages') return { type: 'messages', messages: [] }
    throw new Error(`Unexpected fake command: ${command.type}`)
  }

  getLoadedExtensions(): PiRpcExtensionInventory {
    return EMPTY_INVENTORY
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1
    if (this.disposeFailuresRemaining > 0) {
      this.disposeFailuresRemaining -= 1
      throw new Error('fake disposal failure')
    }
  }
}

function runtimeOptions(sessionFile: string): SharedPiRuntimeOptions {
  return {
    cwd: '/tmp/shared-pi-host-test',
    sessionFile,
    extensionPaths: []
  }
}

function createFakeFactory(drivers: FakeSessionDriver[]): SharedPiSessionFactory {
  return async (_environment, options, callbacks) => {
    const sessionFile = options.sessionFile ?? `/tmp/fake-${drivers.length + 1}.jsonl`
    await callbacks.onIdentityChange(null, sessionFile)
    const driver = new FakeSessionDriver(sessionFile, callbacks)
    drivers.push(driver)
    return driver
  }
}

test('SharedPiHost publishes one exact Session owner and rejects a duplicate identity', async () => {
  const drivers: FakeSessionDriver[] = []
  const host = new SharedPiHost({ createSession: createFakeFactory(drivers) })
  const first = host.createRuntime(runtimeOptions('/tmp/shared-a.jsonl'))
  const second = host.createRuntime(runtimeOptions('/tmp/shared-a.jsonl'))

  await first.start()
  await assert.rejects(second.start(), /already live/u)
  assert.deepEqual(await first.send({ type: 'get_messages' }), { type: 'messages', messages: [] })
  assert.match(second.getState().lastError ?? '', /already live/u)
  assert.equal(drivers.length, 2)
  assert.equal(drivers[0]!.disposeCalls, 0)
  assert.equal(drivers[1]!.disposeCalls, 1)

  await first.stop()
  await host.dispose()
  assert.equal(drivers[0]!.disposeCalls, 1)
})

test('SharedPiHost updates the canonical identity only through the published owner', async () => {
  const drivers: FakeSessionDriver[] = []
  const host = new SharedPiHost({ createSession: createFakeFactory(drivers) })
  const first = host.createRuntime(runtimeOptions('/tmp/shared-before.jsonl'))
  await first.start()

  await drivers[0]!.callbacks.onIdentityChange(
    '/tmp/shared-before.jsonl',
    '/tmp/shared-after.jsonl'
  )

  const oldIdentity = host.createRuntime(runtimeOptions('/tmp/shared-before.jsonl'))
  await oldIdentity.start()
  const duplicateNewIdentity = host.createRuntime(runtimeOptions('/tmp/shared-after.jsonl'))
  await assert.rejects(duplicateNewIdentity.start(), /already live/u)

  await host.dispose()
  assert.equal(drivers[0]!.disposeCalls, 1)
  assert.equal(drivers[1]!.disposeCalls, 1)
  assert.equal(drivers[2]!.disposeCalls, 1)
})

test('SharedPiHost retries a failed Runtime and Host disposal without losing ownership', async () => {
  const drivers: FakeSessionDriver[] = []
  const host = new SharedPiHost({ createSession: createFakeFactory(drivers) })
  const runtime = host.createRuntime(runtimeOptions('/tmp/shared-retry.jsonl'))
  await runtime.start()
  drivers[0]!.disposeFailuresRemaining = 1

  await assert.rejects(host.dispose(), /failed to dispose every Session/u)
  assert.equal(drivers[0]!.disposeCalls, 1)
  await host.dispose()
  assert.equal(drivers[0]!.disposeCalls, 2)
})

test('SharedPiHost retains a duplicate driver when publication cleanup fails', async () => {
  const drivers: FakeSessionDriver[] = []
  let failNextDisposal = false
  const factory: SharedPiSessionFactory = async (_environment, options, callbacks) => {
    const sessionFile = options.sessionFile ?? `/tmp/fake-${drivers.length + 1}.jsonl`
    await callbacks.onIdentityChange(null, sessionFile)
    const driver = new FakeSessionDriver(sessionFile, callbacks)
    if (failNextDisposal) {
      driver.disposeFailuresRemaining = 1
      failNextDisposal = false
    }
    drivers.push(driver)
    return driver
  }
  const host = new SharedPiHost({ createSession: factory })
  const first = host.createRuntime(runtimeOptions('/tmp/shared-publication.jsonl'))
  await first.start()
  failNextDisposal = true
  const duplicate = host.createRuntime(runtimeOptions('/tmp/shared-publication.jsonl'))

  await assert.rejects(duplicate.start(), /publication and cleanup both failed/u)
  assert.equal(drivers[1]!.disposeCalls, 1)
  await duplicate.stop()
  assert.equal(drivers[1]!.disposeCalls, 2)
  await host.dispose()
  assert.equal(drivers[0]!.disposeCalls, 1)
})

test('SharedPiHost disposal drains every live Session and rejects later creation', async () => {
  const drivers: FakeSessionDriver[] = []
  const host = new SharedPiHost({ createSession: createFakeFactory(drivers) })
  const first = host.createRuntime(runtimeOptions('/tmp/shared-one.jsonl'))
  const second = host.createRuntime(runtimeOptions('/tmp/shared-two.jsonl'))

  await Promise.all([first.start(), second.start()])
  await host.dispose()

  assert.deepEqual(drivers.map(({ disposeCalls }) => disposeCalls), [1, 1])
  await assert.rejects(first.send({ type: 'get_messages' }), /not running/u)
  await assert.rejects(second.send({ type: 'get_messages' }), /not running/u)
  assert.throws(
    () => host.createRuntime(runtimeOptions('/tmp/shared-three.jsonl')),
    /not accepting new Sessions/u
  )
})
