import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { KernelExtensionDialogRequest } from '../../shared/kernel-contract.ts'
import { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import { dispatchTerminalKernelCommand } from '../kernel/terminal-kernel-command-dispatcher.ts'
import type { RuntimeHost, RuntimeHostEvent, RuntimeCommand, RuntimeCommandResult } from '../runtime/runtime-host.ts'
import { ProjectStore } from '../project/project-store.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'
import { DesktopHostClient, desktopHostControlIdentity } from './desktop-host-client.ts'
import { openDesktopDeviceStore } from './desktop-device-store.ts'
import { assertDesktopHostKernelCommandPolicy } from './remote-command-policy.ts'

test('Desktop interactions traverse HTTP/SSE, the shared dispatcher and real Kernel with exact request ownership', {
  skip: process.platform !== 'linux', timeout: 15_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-interactions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const listeners = new Set<(event: RuntimeHostEvent) => void>()
  const emit = (event: RuntimeHostEvent) => { for (const listener of listeners) listener(event) }
  const sent: RuntimeCommand[] = []
  let finishInvocation: (() => void) | undefined
  let invocationStarted!: () => void
  const started = new Promise<void>((resolve) => { invocationStarted = resolve })
  const sessionKey = join(root, 'session.jsonl')
  const runtime = {
    start: async () => {}, stop: async () => { finishInvocation?.() }, getRpcPid: () => null,
    getState: () => ({ executable: '/usr/bin/pi', version: '0.99.0', stderrChars: 0, stderrSummary: null, lastError: null, exitCode: null, exitSignal: null }),
    subscribe: (listener: (event: RuntimeHostEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    send: async (command: RuntimeCommand): Promise<RuntimeCommandResult> => {
      sent.push(command)
      switch (command.type) {
        case 'get_state': return { type: 'state', state: { sessionId: 'session-id', sessionFile: sessionKey, sessionName: 'Interaction test', thinkingLevel: 'medium', isStreaming: false, messageCount: 0, pendingMessageCount: 0 } }
        case 'get_messages': return { type: 'messages', messages: [] }
        case 'get_entries': return { type: 'entries', entries: [], leafId: null }
        case 'get_session_stats': return { type: 'session-statistics', statistics: {
          sessionId: 'session-id', sessionFile: sessionKey, userMessages: 0, assistantMessages: 0, toolCalls: 0,
          toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0
        } }
        case 'get_commands': return { type: 'commands', commands: [
          { name: 'run', source: 'extension', sourceInfo: { source: 'npm:pi-subagents@0.37.2', scope: 'user', origin: 'package' } },
          { name: 'unsafe', source: 'extension', sourceInfo: { source: 'npm:unadapted', scope: 'user', origin: 'package' } }
        ] }
        case 'get_available_models': return { type: 'available-models', models: [] }
        case 'invoke_extension_command': return new Promise((resolve) => {
          finishInvocation = () => resolve({ type: 'accepted' })
          invocationStarted()
        })
        default: return { type: 'accepted' }
      }
    }
  } as RuntimeHost
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: root }], activeProjectKey: root }, {
    sessionRegistry: { sessions: [], activeSessionKey: null },
    persistProject: async () => {}, persistActiveProject: async () => {}, persistArchivedSession: async () => {},
    persistSession: async () => {}, persistActiveSession: async () => {}, validateSession: async (pointer) => pointer
  })
  await kernel.start()
  t.after(() => kernel.stop())
  const reserve = createServer()
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()))
  const gateway = await startDesktopHostGateway({
    config: { enabled: true, bindHost: '127.0.0.1', port, token: 'm'.repeat(32), tokenFile: join(root, 'token'), deviceStorePath: join(root, 'device') },
    productVersion: '1.0.0', buildCommit: 'fixture',
    deviceStore: await openDesktopDeviceStore({ path: join(root, 'device'), uid: process.getuid!() }),
    randomPairingCode: () => '123456', randomDeviceCredential: () => 'c'.repeat(43),
    handlers: {
      getControlIdentity: () => desktopHostControlIdentity(kernel.getSnapshot()),
      assertCommandPolicy: (command) => assertDesktopHostKernelCommandPolicy(command, { kernel }),
      dispatchCommand: (command, boundary) => dispatchTerminalKernelCommand(command, {
        kernel, projectStore: store, assertCurrentPolicy: async () => {
          await boundary?.()
          await assertDesktopHostKernelCommandPolicy(command, { kernel })
        }
      })
    }
  })
  t.after(() => gateway.stop())
  const unsubscribe = kernel.subscribe((event) => gateway.publish(event))
  t.after(unsubscribe)
  const client = new DesktopHostClient({ localPort: port, compatibility: { productVersion: '1.0.0', buildCommit: 'fixture' } })
  const compatibility = await client.verifyCompatibility()
  assert.ok(compatibility.capabilities.kernelCommandTypes.includes('kernel.respond-extension-dialog'))
  gateway.createPairingCode()
  await client.pair('123456')
  const controller = '11111111-1111-4111-8111-111111111111'
  const dialogs: KernelExtensionDialogRequest[] = []
  const stream = await client.openEventStream(controller, (event) => {
    for (const update of event.type === 'kernel.state-batch' ? event.events : [event]) {
      if (update.type === 'kernel.state-changed' && update.state.extensionDialog) dialogs.push(update.state.extensionDialog)
    }
  })
  const streamClosed = stream.closed.then(() => null, (error: unknown) => error)
  t.after(() => stream.close())
  const identity = desktopHostControlIdentity(await client.getState(controller))
  const responses = () => sent.filter((command) => command.type === 'extension_ui_response')
  const ask = (id: string) => {
    emit({ type: 'pi-event', event: { type: 'tool_execution_start', toolCallId: id, toolName: 'ask', args: {
      questions: [{ id: 'scope', prompt: 'Choose scope', type: 'single', options: [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }] }]
    } } })
    emit({ type: 'pi-event', event: { type: 'extension_ui_request', id: `ui-${id}`, method: 'select', title: 'Ask · Choose scope', options: ['Small', 'Large', '其他（自行输入）'] } })
  }
  const endAsk = (id: string) => emit({ type: 'pi-event', event: { type: 'tool_execution_end', toolCallId: id, toolName: 'ask', result: { content: [{ type: 'text', text: 'Answered' }] }, isError: false } })
  ask('first')
  const answer = { type: 'kernel.submit-ask' as const, sessionKey, toolCallId: 'first', answers: [{ questionId: 'scope', value: 'large' }] }
  await assert.rejects(client.command(controller, { ...identity, sessionKey: '/old' }, answer), /state changed/)
  await assert.rejects(client.command(controller, identity, { ...answer, toolCallId: 'expired' }))
  await assert.rejects(client.command(controller, identity, { ...answer, sessionKey: '/other' }))
  assert.equal(responses().length, 0)
  await client.command(controller, identity, answer)
  await assert.rejects(client.command(controller, identity, answer))
  assert.deepEqual(responses(), [{ type: 'extension_ui_response', id: 'ui-first', value: 'Large' }])
  endAsk('first')
  ask('cancel')
  const cancelAsk = { type: 'kernel.cancel-ask' as const, sessionKey, toolCallId: 'cancel' }
  await client.command(controller, identity, cancelAsk)
  await assert.rejects(client.command(controller, identity, cancelAsk))
  assert.equal(responses().length, 2)
  endAsk('cancel')

  // A forged GUI command, unknown Extension or oversized argument never reaches Pi.
  for (const commandId of ['gui:new', 'pi-command:extension:unsafe', 'missing']) {
    await assert.rejects(client.command(controller, identity, { type: 'kernel.invoke-command', commandId, argument: '' }), /adapted Extension/)
  }
  const descriptor = kernel.getState().commands.find((command) => command.source === 'extension' && command.name === 'run')!
  await assert.rejects(client.command(controller, identity, { type: 'kernel.invoke-command', commandId: descriptor.id, argument: 'x'.repeat(16_001) }), /bounds/)
  const invocation = client.command(controller, identity, { type: 'kernel.invoke-command', commandId: descriptor.id, argument: 'explorer inspect' })
  const invocationObserved = invocation.then(() => null, (error: unknown) => error)
  // Wait on the actual runtime send, bounded by the enclosing test timeout.
  await started
  const invoked = sent.find((command) => command.type === 'invoke_extension_command')!
  assert.equal(invoked.type, 'invoke_extension_command')
  if (invoked.type !== 'invoke_extension_command') throw new Error('No invocation')
  const show = (id: string, method: 'select' | 'input' | 'editor' | 'confirm') => {
    emit({ type: 'pi-event', event: { type: 'extension_ui_request', id, method, commandName: 'run', commandInvocationId: invoked.invocationId,
      title: 'Remote question', options: ['explorer', 'reviewer'], message: 'Continue?', placeholder: 'Name', prefill: 'Initial' } })
    const request = kernel.getState().extensionDialog
    assert.ok(request)
    return { projectKey: request.projectKey, sessionKey: request.sessionKey, sessionId: request.sessionId, requestId: request.requestId, commandInvocationId: request.commandInvocationId }
  }
  for (const [method, value] of [['select', 'reviewer'], ['input', '中文回答'], ['editor', 'line 1\nline 2'], ['confirm', 'true']] as const) {
    const target = show(`request-${method}`, method)
    const response = { type: 'kernel.respond-extension-dialog' as const, ...target, value }
    const before = responses().length
    for (const key of ['projectKey', 'sessionKey', 'sessionId', 'requestId', 'commandInvocationId'] as const) {
      await assert.rejects(client.command(controller, identity, { ...response, [key]: 'wrong-owner' }))
    }
    if (method === 'select' || method === 'confirm') await assert.rejects(client.command(controller, identity, { ...response, value: 'invalid' }))
    assert.equal(responses().length, before)
    await client.command(controller, identity, response)
    await assert.rejects(client.command(controller, identity, response))
    assert.deepEqual(responses().at(-1), { type: 'extension_ui_response', id: target.requestId, value })
    assert.equal(kernel.getState().extensionDialog, null)
  }
  const cancelled = show('cancel-dialog', 'input')
  await client.command(controller, identity, { type: 'kernel.cancel-extension-dialog', ...cancelled })
  assert.deepEqual(responses().at(-1), { type: 'extension_ui_response', id: 'cancel-dialog', cancelled: true })
  const pending = show('after-disconnect', 'confirm')
  const count = responses().length
  await stream.close()
  // The Host sees the closed stream asynchronously; wait until it has released control.
  for (let attempt = 0; gateway.listDevices()[0]?.controlling !== false; attempt++) {
    assert.ok(attempt < 200, 'Host did not release the closed control stream')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await assert.rejects(client.command(controller, identity, { type: 'kernel.cancel-extension-dialog', ...pending }))
  assert.equal(responses().length, count)
  const reconnected = await client.openEventStream(controller, () => {})
  const reconnectedClosed = reconnected.closed.then(() => null, (error: unknown) => error)
  t.after(() => reconnected.close())
  const restored = await client.getState(controller)
  assert.equal(restored.state.extensionDialog?.requestId, pending.requestId)
  assert.equal(responses().length, count, 'Reconnect must not replay a response')
  await gateway.revokeDevice(gateway.listDevices()[0]!.deviceId)
  await assert.rejects(client.command(controller, identity, { type: 'kernel.cancel-extension-dialog', ...pending }), /Authentication/)
  assert.equal(responses().length, count)
  finishInvocation!()
  await invocationObserved
  assert.ok(dialogs.some((request) => request.requestId === 'request-select'), 'SSE must publish the dialog')
  await reconnected.close()
  await streamClosed
  await reconnectedClosed
})
