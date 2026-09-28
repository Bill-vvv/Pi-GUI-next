import type { DesktopClientStatus } from '../../../../shared/desktop-client-contract'
import { DESKTOP_ATTACHMENT_COMMAND_TYPES } from '../../../../shared/desktop-attachment-contract.ts'
import { DESKTOP_HOST_GIT_READ_COMMAND_TYPES, DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES, type DesktopHostKernelCommandType } from '../../../../shared/desktop-host-contract.ts'

export type WorkbenchClientSurface = {
  git: boolean
  gitReadOnly: boolean
  addProject: boolean
  remoteProjectSelection: boolean
  createTask: boolean
  tasks: boolean
  attachments: boolean
  remoteAttachments: boolean
  archiveSession: boolean
  forkSession: boolean
  exportSession: boolean
  slashCommands: boolean
  extensionCommandsOnly: boolean
  extensionDialogs: boolean
  projectPathMentions: boolean
  settings: boolean
  hostSettings: boolean
  historyPromptEdit: boolean
  disconnectHost: boolean
}

const LOCAL_WORKBENCH_SURFACE: WorkbenchClientSurface = {
  git: true,
  gitReadOnly: false,
  addProject: true,
  remoteProjectSelection: false,
  createTask: true,
  tasks: true,
  attachments: true,
  remoteAttachments: false,
  archiveSession: true,
  forkSession: true,
  exportSession: true,
  slashCommands: true,
  extensionCommandsOnly: false,
  extensionDialogs: true,
  projectPathMentions: true,
  settings: true,
  hostSettings: true,
  historyPromptEdit: true,
  disconnectHost: false
}

export function workbenchClientSurface(
  status: DesktopClientStatus | null
): WorkbenchClientSurface {
  if (status === null || status.mode !== 'windows-remote') return LOCAL_WORKBENCH_SURFACE
  const types = new Set<string>(status.capabilities?.kernelCommandTypes ?? [])
  const has = (type: DesktopHostKernelCommandType | string): boolean => types.has(type)
  return {
    git: DESKTOP_HOST_GIT_READ_COMMAND_TYPES.every((type) => status.capabilities?.gitCommandTypes?.includes(type)),
    gitReadOnly: !DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES.every((type) => status.capabilities?.gitCommandTypes?.includes(type)),
    addProject: has('kernel.add-project') && has('kernel.list-project-directories') && has('kernel.resolve-project-trust'),
    remoteProjectSelection: has('kernel.add-project') && has('kernel.list-project-directories') && has('kernel.resolve-project-trust'),
    createTask: has('kernel.create-task'),
    tasks: has('kernel.activate-task') || has('kernel.create-task'),
    attachments: DESKTOP_ATTACHMENT_COMMAND_TYPES.every((type) => status.capabilities?.attachmentCommandTypes?.includes(type)),
    remoteAttachments: true,
    archiveSession: has('kernel.archive-session'),
    forkSession: has('kernel.fork-session'),
    exportSession: has('kernel.export-session'),
    slashCommands: has('kernel.invoke-command') && has('kernel.respond-extension-dialog') && has('kernel.cancel-extension-dialog'),
    extensionCommandsOnly: true,
    extensionDialogs: has('kernel.respond-extension-dialog') && has('kernel.cancel-extension-dialog'),
    projectPathMentions: has('kernel.search-project-paths'),
    settings: true,
    hostSettings: false,
    historyPromptEdit: has('kernel.navigate-history-prompt'),
    disconnectHost: true
  }
}
