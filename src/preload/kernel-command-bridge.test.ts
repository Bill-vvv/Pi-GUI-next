import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernelCommandBridge } from './kernel-command-bridge.ts'

test('queued commands keep the identity observed at submission across navigation', async () => {
  const sent: unknown[] = []
  const bridge = createKernelCommandBridge(async (command, identity) => { sent.push({ command, identity }) })
  const observed = { projectKey: '/project', sessionKey: 'A' }
  bridge.setControlIdentity(observed)
  observed.sessionKey = 'mutated-by-caller'
  await bridge.invoke({ type: 'kernel.abort' })
  bridge.setControlIdentity({ projectKey: '/project', sessionKey: 'B' })
  bridge.setControlIdentity(null)
  await bridge.invoke({ type: 'kernel.abort' })
  assert.deepEqual(sent, [
    { command: { type: 'kernel.abort' }, identity: { projectKey: '/project', sessionKey: 'A' } },
    { command: { type: 'kernel.abort' }, identity: null }
  ])
})

test('Git bridge captures the same observed identity without exposing its mutable owner', () => {
  const bridge = createKernelCommandBridge(async () => {})
  bridge.setControlIdentity({ projectKey: '/project', sessionKey: 'A' })
  const gitIdentity = bridge.getControlIdentity()!
  gitIdentity.sessionKey = 'caller-mutated'
  assert.deepEqual(bridge.getControlIdentity(), { projectKey: '/project', sessionKey: 'A' })
  bridge.setControlIdentity(null)
  assert.equal(bridge.getControlIdentity(), null)
})
