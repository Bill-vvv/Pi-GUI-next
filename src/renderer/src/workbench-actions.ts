/** Canonical renderer-local Workbench operation ids. */
export const WORKBENCH_ACTION_IDS = [
  'add-project',
  'activate-project',
  'select-navigator',
  'create-task',
  'activate-task',
  'start-session',
  'reload-session',
  'activate-session',
  'preview-session',
  'archive-session',
  'undo-archive-session',
  'preview-archived-session',
  'fork-session',
  'edit-history-prompt',
  'reorder-projects',
  'resolve-project-trust',
  'prompt',
  'steer',
  'follow-up',
  'abort',
  'submit-ask',
  'cancel-ask',
  'invoke-command',
  'set-model',
  'set-thinking-level',
  'set-openai-fast-mode',
  'set-general',
  'set-appearance',
  'set-session-naming',
  'set-subagent',
  'set-subagent-enabled',
  'set-magic-context-enabled',
  'set-shortcuts',
  'install-extension',
  'remove-extension',
  'install-pi-dev-package',
  'remove-pi-package',
  'update-pi-package',
  'update-pi-packages',
  'export-session',
  'copy-last-answer'
] as const

export type WorkbenchActionId = (typeof WORKBENCH_ACTION_IDS)[number]
export type WorkbenchActionOrigin = 'conversation' | 'settings'

export type WorkbenchOperation =
  | { id: Exclude<WorkbenchActionId, 'set-model'> }
  | { id: 'set-model'; origin: WorkbenchActionOrigin }

export type WorkbenchCompletedAction = {
  action: WorkbenchOperation
  succeeded: boolean
}

export type WorkbenchSettingsActionSection =
  | 'general'
  | 'appearance'
  | 'models'
  | 'extensions'
  | 'subagent'

export type WorkbenchActionErrorOwner =
  | 'local'
  | 'header'
  | 'timeline'
  | 'conversation-actions'
  | 'extension'
  | WorkbenchSettingsActionSection

export type WorkbenchGlobalActionErrorOwner = Exclude<
  WorkbenchActionErrorOwner,
  'local'
>

export type WorkbenchActionFailure = {
  owner: WorkbenchGlobalActionErrorOwner
  message: string
}

type SimpleWorkbenchActionId = Exclude<WorkbenchActionId, 'set-model'>
type WorkbenchActionPresentation = {
  runtimeContext: boolean
  runtimeStatus: string | null
  errorOwner: WorkbenchActionErrorOwner
}

const LOCAL = {
  runtimeContext: false,
  runtimeStatus: null,
  errorOwner: 'local'
} as const satisfies WorkbenchActionPresentation
const HEADER = {
  ...LOCAL,
  errorOwner: 'header'
} as const satisfies WorkbenchActionPresentation
const TIMELINE = {
  ...LOCAL,
  errorOwner: 'timeline'
} as const satisfies WorkbenchActionPresentation
const CONVERSATION_ACTIONS = {
  ...LOCAL,
  errorOwner: 'conversation-actions'
} as const satisfies WorkbenchActionPresentation
const EXTENSION = {
  ...LOCAL,
  errorOwner: 'extension'
} as const satisfies WorkbenchActionPresentation
const RUNTIME_CONTEXT = {
  ...HEADER,
  runtimeContext: true
} as const satisfies WorkbenchActionPresentation

/**
 * Single presentation owner for every non-model action. Adding an action must
 * classify it here, while `set-model` is routed by its explicit origin.
 */
const WORKBENCH_ACTION_PRESENTATION = {
  'add-project': { ...RUNTIME_CONTEXT, runtimeStatus: '正在添加项目…' },
  'activate-project': { ...RUNTIME_CONTEXT, runtimeStatus: '正在切换项目…' },
  'select-navigator': { ...RUNTIME_CONTEXT, runtimeStatus: '正在切换工作区…' },
  'create-task': { ...RUNTIME_CONTEXT, runtimeStatus: '正在创建任务…' },
  'activate-task': { ...RUNTIME_CONTEXT, runtimeStatus: '正在切换任务…' },
  'start-session': RUNTIME_CONTEXT,
  'reload-session': HEADER,
  'activate-session': { ...RUNTIME_CONTEXT, runtimeStatus: '正在切换对话…' },
  'preview-session': { ...HEADER, runtimeStatus: '正在读取对话…' },
  'archive-session': { ...HEADER, runtimeStatus: '正在归档对话…' },
  'undo-archive-session': HEADER,
  'preview-archived-session': HEADER,
  'fork-session': LOCAL,
  'edit-history-prompt': LOCAL,
  'reorder-projects': { ...HEADER, runtimeStatus: '正在保存排序…' },
  'resolve-project-trust': LOCAL,
  prompt: LOCAL,
  steer: LOCAL,
  'follow-up': LOCAL,
  abort: LOCAL,
  'submit-ask': LOCAL,
  'cancel-ask': LOCAL,
  'invoke-command': LOCAL,
  'set-thinking-level': TIMELINE,
  'set-openai-fast-mode': TIMELINE,
  'set-general': { ...HEADER, errorOwner: 'general' },
  'set-appearance': { ...HEADER, errorOwner: 'appearance' },
  'set-session-naming': { ...HEADER, errorOwner: 'general' },
  'set-subagent': { ...HEADER, errorOwner: 'subagent' },
  'set-subagent-enabled': { ...HEADER, errorOwner: 'subagent' },
  'set-magic-context-enabled': { ...HEADER, errorOwner: 'extensions' },
  'set-shortcuts': LOCAL,
  'install-extension': EXTENSION,
  'remove-extension': EXTENSION,
  'install-pi-dev-package': LOCAL,
  'remove-pi-package': LOCAL,
  'update-pi-package': LOCAL,
  'update-pi-packages': LOCAL,
  'export-session': CONVERSATION_ACTIONS,
  'copy-last-answer': CONVERSATION_ACTIONS
} as const satisfies Record<SimpleWorkbenchActionId, WorkbenchActionPresentation>

export function workbenchOp<Id extends SimpleWorkbenchActionId>(id: Id): { id: Id }
export function workbenchOp(
  id: 'set-model',
  origin: WorkbenchActionOrigin
): { id: 'set-model'; origin: WorkbenchActionOrigin }
export function workbenchOp(
  id: WorkbenchActionId,
  origin?: WorkbenchActionOrigin
): WorkbenchOperation {
  if (id === 'set-model') {
    if (origin !== 'conversation' && origin !== 'settings') {
      throw new Error('set-model requires an explicit conversation or settings origin.')
    }
    return { id, origin }
  }
  return { id }
}

export function isWorkbenchAction(
  operation: WorkbenchOperation | null | undefined,
  id: WorkbenchActionId
): boolean {
  return operation?.id === id
}

export function workbenchActionErrorOwner(
  operation: WorkbenchOperation
): WorkbenchActionErrorOwner {
  if (operation.id === 'set-model') {
    return operation.origin === 'conversation' ? 'timeline' : 'models'
  }
  return WORKBENCH_ACTION_PRESENTATION[operation.id].errorOwner
}

export function workbenchGlobalActionErrorOwner(
  operation: WorkbenchOperation
): WorkbenchGlobalActionErrorOwner | null {
  const owner = workbenchActionErrorOwner(operation)
  return owner === 'local' ? null : owner
}

export function isRuntimeContextAction(operation: WorkbenchOperation | null): boolean {
  return presentationFor(operation)?.runtimeContext === true
}

export function runtimeContextActionStatus(
  operation: WorkbenchOperation | null
): string | null {
  return presentationFor(operation)?.runtimeStatus ?? null
}

function presentationFor(
  operation: WorkbenchOperation | null
): WorkbenchActionPresentation | null {
  if (operation === null) return null
  if (operation.id === 'set-model') {
    return {
      ...LOCAL,
      errorOwner: workbenchActionErrorOwner(operation)
    }
  }
  return WORKBENCH_ACTION_PRESENTATION[operation.id]
}
