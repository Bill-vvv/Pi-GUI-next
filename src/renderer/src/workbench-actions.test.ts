import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  WORKBENCH_ACTION_IDS,
  isRuntimeContextAction,
  isWorkbenchAction,
  runtimeContextActionStatus,
  workbenchActionErrorOwner,
  workbenchGlobalActionErrorOwner,
  workbenchOp,
  type WorkbenchActionErrorOwner,
  type WorkbenchActionId,
  type WorkbenchOperation
} from './workbench-actions.ts'

const expectedSimpleOwners = {
  'add-project': 'header',
  'activate-project': 'header',
  'select-navigator': 'header',
  'create-task': 'header',
  'activate-task': 'header',
  'start-session': 'header',
  'reload-session': 'header',
  'activate-session': 'header',
  'preview-session': 'header',
  'archive-session': 'header',
  'undo-archive-session': 'header',
  'preview-archived-session': 'header',
  'fork-session': 'local',
  'edit-history-prompt': 'local',
  'reorder-projects': 'header',
  'resolve-project-trust': 'local',
  prompt: 'local',
  steer: 'local',
  'follow-up': 'local',
  abort: 'local',
  'submit-ask': 'local',
  'cancel-ask': 'local',
  'invoke-command': 'local',
  'set-thinking-level': 'timeline',
  'set-openai-fast-mode': 'timeline',
  'set-general': 'general',
  'set-appearance': 'appearance',
  'set-session-naming': 'general',
  'set-subagent': 'subagent',
  'set-subagent-enabled': 'subagent',
  'set-magic-context-enabled': 'extensions',
  'set-shortcuts': 'local',
  'install-extension': 'extension',
  'remove-extension': 'extension',
  'install-pi-dev-package': 'local',
  'remove-pi-package': 'local',
  'update-pi-package': 'local',
  'update-pi-packages': 'local',
  'export-session': 'conversation-actions',
  'copy-last-answer': 'conversation-actions'
} as const satisfies Record<
  Exclude<WorkbenchActionId, 'set-model'>,
  WorkbenchActionErrorOwner
>

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(
  new URL('./composition/Workbench.tsx', import.meta.url),
  'utf8'
)

test('every workbench action id is unique, non-empty, and has one explicit error owner', () => {
  assert.equal(new Set(WORKBENCH_ACTION_IDS).size, WORKBENCH_ACTION_IDS.length)
  for (const id of WORKBENCH_ACTION_IDS) {
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
    if (id === 'set-model') continue
    assert.equal(workbenchActionErrorOwner(workbenchOp(id)), expectedSimpleOwners[id])
  }
})

test('workbenchOp requires origin only for set-model', () => {
  assert.deepEqual(workbenchOp('prompt'), { id: 'prompt' })
  assert.deepEqual(workbenchOp('set-model', 'conversation'), {
    id: 'set-model',
    origin: 'conversation'
  })
  assert.deepEqual(workbenchOp('set-model', 'settings'), {
    id: 'set-model',
    origin: 'settings'
  })
  assert.throws(
    () => workbenchOp('set-model', undefined as never),
    /set-model requires an explicit conversation or settings origin/
  )
})

test('set-model origin routes conversation and settings errors to distinct owners', () => {
  assert.equal(workbenchActionErrorOwner(workbenchOp('set-model', 'conversation')), 'timeline')
  assert.equal(workbenchActionErrorOwner(workbenchOp('set-model', 'settings')), 'models')
})

test('feature-local actions never publish through a global Workbench error surface', () => {
  const localIds = [
    'fork-session',
    'resolve-project-trust',
    'prompt',
    'steer',
    'follow-up',
    'abort',
    'submit-ask',
    'cancel-ask',
    'invoke-command',
    'set-shortcuts',
    'install-pi-dev-package',
    'remove-pi-package',
    'update-pi-package',
    'update-pi-packages'
  ] as const

  for (const id of localIds) {
    const operation = workbenchOp(id)
    assert.equal(workbenchActionErrorOwner(operation), 'local')
    assert.equal(workbenchGlobalActionErrorOwner(operation), null)
  }
  assert.equal(
    appSource.match(/const globalErrorOwner = workbenchGlobalActionErrorOwner\(action\)/g)?.length,
    2
  )
})

test('workspace metadata refresh uses the latest action presentation fence', () => {
  const refreshFunction = appSource.match(
    /function requestWorkspaceMetadataRefresh[\s\S]*?\n  }\n\n  const \{/
  )?.[0]
  assert.ok(refreshFunction)
  assert.match(
    refreshFunction,
    /const presentationRevision = actionPresentationRevision\.current \+ 1/
  )
  assert.equal(
    refreshFunction.match(
      /actionPresentationRevision\.current !== presentationRevision/g
    )?.length,
    2
  )
  assert.equal(
    refreshFunction.match(
      /kernelStateRef\.current\?\.activeProjectKey !== workspaceKey/g
    )?.length,
    2
  )
  assert.match(refreshFunction, /setActionFailure\(null\)/)
  assert.match(
    refreshFunction,
    /setActionFailure\(\{ owner: 'header', message: errorMessage\(error\) }\)/
  )
})

test('Workbench routes only explicit owners and has no unclassified Header fallback', () => {
  assert.match(workbenchSource, /actionFailure\?\.owner === 'header'/)
  assert.match(workbenchSource, /actionFailure\?\.owner === 'timeline'/)
  assert.match(workbenchSource, /actionFailure\?\.owner === 'conversation-actions'/)
  assert.match(workbenchSource, /actionFailure\?\.owner === 'extension'/)
  assert.match(workbenchSource, /actionFailure\?\.owner === settingsSection/)
  assert.doesNotMatch(workbenchSource, /timelineActionError === null/)
  assert.doesNotMatch(workbenchSource, /conversationActionError === null/)
})

test('routing helpers stay exhaustive over the canonical action set', () => {
  const operations: WorkbenchOperation[] = WORKBENCH_ACTION_IDS.map((id): WorkbenchOperation => {
    if (id === 'set-model') return workbenchOp('set-model', 'conversation')
    return workbenchOp(id)
  })

  for (const operation of operations) {
    const owner = workbenchActionErrorOwner(operation)
    assert.equal(typeof owner, 'string')
    assert.equal(
      workbenchGlobalActionErrorOwner(operation),
      owner === 'local' ? null : owner
    )
    assert.equal(typeof isRuntimeContextAction(operation), 'boolean')
    const status = runtimeContextActionStatus(operation)
    assert.ok(status === null || typeof status === 'string')
    assert.equal(isWorkbenchAction(operation, operation.id), true)
  }
})

test('runtime context status labels remain unchanged', () => {
  assert.equal(runtimeContextActionStatus(workbenchOp('add-project')), '正在添加项目…')
  assert.equal(runtimeContextActionStatus(workbenchOp('activate-project')), '正在切换项目…')
  assert.equal(runtimeContextActionStatus(workbenchOp('activate-session')), '正在切换对话…')
  assert.equal(runtimeContextActionStatus(workbenchOp('preview-session')), '正在读取对话…')
  assert.equal(runtimeContextActionStatus(workbenchOp('archive-session')), '正在归档对话…')
  assert.equal(runtimeContextActionStatus(workbenchOp('reorder-projects')), '正在保存排序…')
  assert.equal(runtimeContextActionStatus(workbenchOp('prompt')), null)
  assert.equal(isRuntimeContextAction(workbenchOp('start-session')), true)
  assert.equal(isRuntimeContextAction(workbenchOp('export-session')), false)
})
