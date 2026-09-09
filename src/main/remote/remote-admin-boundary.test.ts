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
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.get-tailscale-status' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.enable-tailscale-funnel' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.enable-tailscale-serve' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.disable-tailscale' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.get-desktop-host-status' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.create-desktop-host-pairing-code' }), true)
  assert.equal(isRemoteAdminCommand({ type: 'remote-admin.revoke-desktop-host-device' }), true)
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
  assert.match(source, /case 'remote-admin\.get-tailscale-status'/u)
  assert.match(source, /case 'remote-admin\.enable-tailscale-funnel'/u)
  assert.match(source, /case 'remote-admin\.enable-tailscale-serve'/u)
  assert.match(source, /case 'remote-admin\.disable-tailscale'/u)
  assert.match(source, /case 'remote-admin\.get-desktop-host-status'/u)
  assert.match(source, /case 'remote-admin\.create-desktop-host-pairing-code'/u)
  assert.match(source, /case 'remote-admin\.revoke-desktop-host-device'/u)

  assert.equal(source.includes('Remote access is disabled.'), true)
  assert.equal(source.includes('Desktop Host is disabled.'), true)
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
  const dispatchStart = source.indexOf('const dispatchRemoteCommand = async (')
  const dispatchEnd = source.indexOf('\n\n  const remoteConfig', dispatchStart)
  assert.ok(dispatchStart > 0)
  assert.ok(dispatchEnd > dispatchStart)
  const dispatchSource = source.slice(dispatchStart, dispatchEnd)
  const terminalDispatchIndex = dispatchSource.indexOf('await dispatchTerminalKernelCommand(command,')
  const controllerBoundaryIndex = dispatchSource.indexOf('await assertCurrentBoundary?.()')
  const policyIndex = dispatchSource.indexOf('await assertRemoteKernelCommandPolicy(command,')
  const activationGuardIndex = dispatchSource.indexOf(
    "if (command.type !== 'kernel.activate-project') return result"
  )
  const refreshIndex = dispatchSource.indexOf(
    'await activeKernel.refreshWorkspaceMetadata(command.projectKey)'
  )
  const acknowledgeIndex = dispatchSource.indexOf('return activeKernel.acknowledge()')
  assert.ok(terminalDispatchIndex >= 0)
  assert.ok(controllerBoundaryIndex > terminalDispatchIndex)
  assert.ok(policyIndex > controllerBoundaryIndex)
  assert.ok(activationGuardIndex > terminalDispatchIndex)
  assert.ok(refreshIndex > activationGuardIndex)
  assert.ok(acknowledgeIndex > refreshIndex)
})

test('Main validates and restores managed Tailscale ownership around gateway startup', async () => {
  const source = await readFile(mainIndexPath, 'utf8')
  const managedStart = source.indexOf('} else if (managedTailscaleConfig !== null) {')
  const managedEnd = source.indexOf('\n  }\n\n  const desktopHostConfig', managedStart)
  assert.ok(managedStart > 0)
  assert.ok(managedEnd > managedStart)
  const managedSource = source.slice(managedStart, managedEnd)
  const prepareIndex = managedSource.indexOf('prepareEnable(managedTailscaleConfig.mode)')
  const startIndex = managedSource.indexOf('startApplicationRemoteGateway(')
  const activateIndex = managedSource.indexOf('activate(prepared, managedTailscaleConfig.port)')
  assert.ok(prepareIndex >= 0)
  assert.ok(startIndex > prepareIndex)
  assert.ok(activateIndex > startIndex)

  const cleanupStart = source.indexOf('if (manager.getManagedConfig() === null) {')
  const cleanupEnd = source.indexOf('\n    }\n    throw error', cleanupStart)
  assert.ok(cleanupStart > 0)
  assert.ok(cleanupEnd > cleanupStart)
  const cleanupSource = source.slice(cleanupStart, cleanupEnd)
  const stopIndex = cleanupSource.indexOf('await gateway.stop()')
  const clearOwnerIndex = cleanupSource.indexOf('remoteGateway = null')
  assert.ok(stopIndex >= 0)
  assert.ok(clearOwnerIndex > stopIndex)
  assert.match(cleanupSource, /AggregateError/u)
  assert.doesNotMatch(cleanupSource, /gateway\.stop\(\)\.catch/u)
})

test('Main opens each device store before starting its gateway', async () => {
  const source = await readFile(mainIndexPath, 'utf8')
  const webHelperStart = source.indexOf('async function startApplicationRemoteGateway(')
  const webHelperEnd = source.indexOf('\n\nasync function enableTailscaleRemote(', webHelperStart)
  assert.ok(webHelperStart > 0)
  assert.ok(webHelperEnd > webHelperStart)
  const webHelper = source.slice(webHelperStart, webHelperEnd)
  const webOpenIndex = webHelper.indexOf('openRemoteDeviceStore(')
  const webStartIndex = webHelper.indexOf('startRemoteGateway(')
  assert.ok(webOpenIndex > 0)
  assert.ok(webStartIndex > webOpenIndex)
  assert.match(webHelper, /path:\s*config\.deviceStorePath/u)
  assert.match(webHelper, /deviceStore,/u)

  const desktopOpenIndex = source.indexOf(
    'const desktopHostDeviceStore = await openRemoteDeviceStore('
  )
  const desktopStartIndex = source.indexOf('startDesktopHostGateway(')
  assert.ok(desktopOpenIndex > 0)
  assert.ok(desktopStartIndex > desktopOpenIndex)
  assert.match(source, /path:\s*desktopHostConfig\.deviceStorePath/u)
  assert.match(source, /deviceStore:\s*desktopHostDeviceStore/u)
})
