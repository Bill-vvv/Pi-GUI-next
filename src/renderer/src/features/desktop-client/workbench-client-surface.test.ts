import assert from 'node:assert/strict'
import test from 'node:test'

import { DESKTOP_HOST_KERNEL_COMMAND_TYPES, DESKTOP_HOST_GIT_READ_COMMAND_TYPES as DESKTOP_HOST_GIT_COMMAND_TYPES, DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES } from '../../../../shared/desktop-host-contract.ts'
import { workbenchClientSurface } from './workbench-client-surface.ts'
import { DESKTOP_ATTACHMENT_COMMAND_TYPES } from '../../../../shared/desktop-attachment-contract.ts'

test('remote attachments require every upload and submission capability', () => {
  const status = { mode: 'windows-remote' as const, phase: 'connected' as const, hasStoredCredential: true,
    lastHost: null, error: null, failureKind: null, recovery: null,
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES } }
  assert.equal(workbenchClientSurface(status).attachments, true)
  assert.equal(workbenchClientSurface(status).remoteAttachments, true)
  assert.equal(workbenchClientSurface({ mode: 'wsl' }).remoteAttachments, false)
  for (const missing of DESKTOP_ATTACHMENT_COMMAND_TYPES) assert.equal(workbenchClientSurface({ ...status,
    capabilities: { ...status.capabilities, attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES.filter((type) => type !== missing) }
  }).attachments, false, missing)
})

test('local and WSL Workbench surfaces keep Git, attachments, and Settings', () => {
  assert.equal(workbenchClientSurface({ mode: 'local' }).git, true)
  assert.equal(workbenchClientSurface({ mode: 'wsl' }).attachments, true)
  assert.equal(workbenchClientSurface(null).settings, true)
  assert.equal(workbenchClientSurface({ mode: 'local' }).disconnectHost, false)
})

test('remote Extension invocation requires both dialog response capabilities', () => {
  for (const missing of ['kernel.invoke-command', 'kernel.respond-extension-dialog', 'kernel.cancel-extension-dialog'] as const) {
    const surface = workbenchClientSurface({ mode: 'windows-remote', phase: 'connected', hasStoredCredential: true,
      lastHost: null, error: null, failureKind: null, recovery: null,
      capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES.filter((type) => type !== missing) } })
    assert.equal(surface.slashCommands, false)
    assert.equal(surface.extensionDialogs, missing === 'kernel.invoke-command')
  }
})

test('remote Git review requires its complete read capability and keeps writes unavailable', () => {
  const status = {
    mode: 'windows-remote' as const, phase: 'connected' as const, hasStoredCredential: true,
    lastHost: null, capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES },
    error: null, failureKind: null, recovery: null
  }
  assert.equal(workbenchClientSurface(status).git, true)
  assert.equal(workbenchClientSurface(status).gitReadOnly, true)
  assert.equal(workbenchClientSurface({ mode: 'wsl' }).gitReadOnly, false)
  for (const missing of DESKTOP_HOST_GIT_COMMAND_TYPES) {
    assert.equal(workbenchClientSurface({ ...status, capabilities: { ...status.capabilities,
      gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES.filter((type) => type !== missing)
    } }).git, false, missing)
  }
})

test('remote Git writes require all staging, preview and commit capabilities', () => {
  const status = { mode: 'windows-remote' as const, phase: 'connected' as const, hasStoredCredential: true,
    lastHost: null, error: null, failureKind: null, recovery: null,
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, gitCommandTypes: [...DESKTOP_HOST_GIT_COMMAND_TYPES, ...DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES] } }
  assert.equal(workbenchClientSurface(status).gitReadOnly, false)
  for (const missing of DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES) {
    const surface = workbenchClientSurface({ ...status, capabilities: { ...status.capabilities,
      gitCommandTypes: status.capabilities.gitCommandTypes.filter((type) => type !== missing) } })
    assert.equal(surface.gitReadOnly, true)
    assert.equal(surface.git, true)
  }
})

test('Windows remote Workbench surface follows Host command types and hides local-only actions', () => {
  const surface = workbenchClientSurface({
    mode: 'windows-remote',
    phase: 'connected',
    hasStoredCredential: true,
    lastHost: { sshHostAlias: 'pi-linux', localPort: 18788, desktopHostPort: 18788 },
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES },
    error: null,
    failureKind: null,
    recovery: null
  })
  assert.equal(surface.git, false)
  assert.equal(surface.attachments, false)
  assert.equal(surface.addProject, true)
  assert.equal(surface.remoteProjectSelection, true)
  assert.equal(surface.createTask, false)
  assert.equal(surface.tasks, false)
  assert.equal(surface.archiveSession, false)
  assert.equal(surface.forkSession, false)
  assert.equal(surface.exportSession, false)
  assert.equal(surface.slashCommands, true)
  assert.equal(surface.extensionCommandsOnly, true)
  assert.equal(surface.extensionDialogs, true)
  assert.equal(surface.projectPathMentions, false)
  assert.equal(surface.settings, true)
  assert.equal(surface.hostSettings, false)
  assert.equal(surface.historyPromptEdit, false)
  assert.equal(surface.disconnectHost, true)
})

test('remote project selection requires directory, registration and trust capabilities together', () => {
  for (const missing of ['kernel.list-project-directories', 'kernel.add-project', 'kernel.resolve-project-trust'] as const) {
    const surface = workbenchClientSurface({
      mode: 'windows-remote', phase: 'connected', hasStoredCredential: true,
      lastHost: null, capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES.filter((type) => type !== missing) },
      error: null, failureKind: null, recovery: null
    })
    assert.equal(surface.addProject, false, missing)
    assert.equal(surface.remoteProjectSelection, false, missing)
  }
})
