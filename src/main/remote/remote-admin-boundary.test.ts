import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  REMOTE_ADMIN_COMMAND_CHANNEL,
  isRemoteAdminCommand
} from '../../shared/remote-admin-contract.ts'
import { isRemoteKernelCommand } from '../../shared/remote-contract.ts'

const mainIndexPath = join(dirname(fileURLToPath(import.meta.url)), '../index.ts')

test('isRemoteAdminCommand accepts only the closed admin command set', () => {
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.get-status' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.create-pairing-code' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.revoke-device' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.get-status', extra: true }), false)
  assert.equal(isRemoteAdminCommand({ type: 'kernel.get-state' }), false)
  assert.equal(isRemoteAdminCommand(null), false)
})

test('Main registers remote admin IPC on its own channel with trusted-sender and type guards', async () => {
  const source = await readFile(mainIndexPath, 'utf8')

  assert.match(source, new RegExp(String.raw`REMOTE_ADMIN_COMMAND_CHANNEL`))
  assert.match(source, /ipcMain\.handle\(\s*REMOTE_ADMIN_COMMAND_CHANNEL/u)
  assert.match(source, /assertTrustedIpcSender\(event, rendererTarget\)/u)
  assert.match(source, /isRemoteAdminCommand\(command\)/u)
  assert.match(source, /dispatchRemoteAdminCommand\(command\)/u)

  assert.match(source, /case 'remote-admin\.get-status'/u)
  assert.match(source, /case 'remote-admin\.create-pairing-code'/u)
  assert.match(source, /case 'remote-admin\.revoke-device'/u)

  assert.equal(source.includes('Remote access is disabled.'), true)
  assert.match(source, /enabled:\s*false/u)

  // Admin path must not be folded into Kernel command dispatch or remote allowlist.
  assert.equal(source.includes('REMOTE_ADMIN_COMMAND_CHANNEL = KERNEL_COMMAND_CHANNEL'), false)
  const kernelHandlerStart = source.indexOf('ipcMain.handle(KERNEL_COMMAND_CHANNEL')
  assert.ok(kernelHandlerStart > 0)
  const kernelHandlerSlice = source.slice(kernelHandlerStart, kernelHandlerStart + 2500)
  assert.equal(kernelHandlerSlice.includes('remote-admin.'), false)

  // Channel constant remains the shared admin seam.
  assert.equal(REMOTE_ADMIN_COMMAND_CHANNEL, 'remote-admin:command')
})

test('remote Project activation refreshes metadata without exposing the refresh command', async () => {
  assert.equal(isRemoteKernelCommand({
    type: 'kernel.refresh-workspace-metadata',
    workspaceKey: '/tmp/project'
  }), false)

  const source = await readFile(mainIndexPath, 'utf8')
  const dispatchStart = source.indexOf('dispatchCommand: async (command) =>')
  const dispatchEnd = source.indexOf('\n        }\n      }\n    })', dispatchStart)
  assert.ok(dispatchStart > 0)
  assert.ok(dispatchEnd > dispatchStart)
  const dispatchSource = source.slice(dispatchStart, dispatchEnd)
  const terminalDispatchIndex = dispatchSource.indexOf('await dispatchTerminalKernelCommand(command,')
  const activationGuardIndex = dispatchSource.indexOf(
    "if (command.type !== 'kernel.activate-project') return result"
  )
  const refreshIndex = dispatchSource.indexOf(
    'await activeKernel.refreshWorkspaceMetadata(command.projectKey)'
  )
  const acknowledgeIndex = dispatchSource.indexOf('return activeKernel.acknowledge()')
  assert.ok(terminalDispatchIndex >= 0)
  assert.ok(activationGuardIndex > terminalDispatchIndex)
  assert.ok(refreshIndex > activationGuardIndex)
  assert.ok(acknowledgeIndex > refreshIndex)
})

test('Main opens the device store before starting the remote gateway', async () => {
  const source = await readFile(mainIndexPath, 'utf8')
  const openIndex = source.indexOf('openRemoteDeviceStore(')
  const startIndex = source.indexOf('startRemoteGateway(')
  assert.ok(openIndex > 0)
  assert.ok(startIndex > openIndex)
  assert.match(source, /deviceStore:\s*remoteDeviceStore/u)
  assert.match(source, /path:\s*remoteConfig\.deviceStorePath/u)
})
