import assert from 'node:assert/strict'
import test from 'node:test'

import type { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import {
  assertRemoteKernelCommandPolicy,
  RemoteCommandPolicyError,
  type RemoteCommandPolicyContext
} from './remote-command-policy.ts'

function policyContext(
  taskPaths: string[] = [],
  activeProjectKey: string | null = null
): RemoteCommandPolicyContext {
  const kernel = {
    getState() {
      return {
        activeProjectKey,
        projects: [
          ...taskPaths.map((path) => ({ path, workspaceKind: 'task' as const })),
          ...(activeProjectKey !== null && !taskPaths.includes(activeProjectKey)
            ? [{ path: activeProjectKey, workspaceKind: 'project' as const }]
            : [])
        ]
      }
    }
  } as unknown as WorkbenchKernel
  return { kernel }
}

test('remote prompt requires expectedSessionKey and forbids attachments', async () => {
  await assert.rejects(
    () => assertRemoteKernelCommandPolicy(
      { type: 'kernel.prompt', message: 'hi' },
      policyContext()
    ),
    (error: unknown) => error instanceof RemoteCommandPolicyError &&
      /expectedSessionKey/.test(error.message)
  )

  await assert.rejects(
    () => assertRemoteKernelCommandPolicy(
      {
        type: 'kernel.prompt',
        message: 'hi',
        expectedSessionKey: '/tmp/session.jsonl',
        attachments: [{ type: 'file', name: 'a.txt', path: '/tmp/a.txt' }]
      },
      policyContext()
    ),
    (error: unknown) => error instanceof RemoteCommandPolicyError &&
      /attachments/.test(error.message)
  )

  await assertRemoteKernelCommandPolicy(
    {
      type: 'kernel.prompt',
      message: 'hi',
      expectedSessionKey: '/tmp/session.jsonl'
    },
    policyContext()
  )
})

test('remote steer and follow-up forbid attachments', async () => {
  for (const type of ['kernel.steer', 'kernel.follow-up'] as const) {
    await assert.rejects(
      () => assertRemoteKernelCommandPolicy(
        {
          type,
          message: 'nudge',
          attachments: [{ type: 'file', name: 'a.txt', path: '/tmp/a.txt' }]
        },
        policyContext()
      ),
      RemoteCommandPolicyError
    )
  }
})

test('remote rejects task workspace activation and active task mutations', async () => {
  const taskPath = '/tmp/task-workspace'
  await assert.rejects(
    () => assertRemoteKernelCommandPolicy(
      { type: 'kernel.activate-project', projectKey: taskPath },
      policyContext([taskPath])
    ),
    (error: unknown) => error instanceof RemoteCommandPolicyError &&
      /task workspaces/.test(error.message)
  )

  await assert.rejects(
    () => assertRemoteKernelCommandPolicy(
      { type: 'kernel.abort' },
      policyContext([taskPath], taskPath)
    ),
    (error: unknown) => error instanceof RemoteCommandPolicyError &&
      /task workspaces/.test(error.message)
  )

  await assertRemoteKernelCommandPolicy(
    { type: 'kernel.activate-project', projectKey: '/tmp/real-project' },
    policyContext([taskPath], taskPath)
  )
})

test('allowlisted commands pass for ordinary Projects', async () => {
  await assertRemoteKernelCommandPolicy(
    { type: 'kernel.get-state' },
    policyContext([], '/tmp/real-project')
  )
  await assertRemoteKernelCommandPolicy(
    { type: 'kernel.abort' },
    policyContext([], '/tmp/real-project')
  )
})
