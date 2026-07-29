import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createActiveRegisteredGitProjectResolver,
  type GitProjectResolverKernel,
  type GitProjectResolverStore
} from './git-active-project-resolver.ts'

const PROJECT = '/tmp/pi-gui-project'

function harness(): {
  state: ReturnType<GitProjectResolverKernel['getState']>
  kernel: GitProjectResolverKernel
  store: GitProjectResolverStore
} {
  const state = {
    navigatorKind: 'project' as const,
    activeProjectKey: PROJECT,
    projects: [{ path: PROJECT }]
  }
  return {
    state,
    kernel: { getState: () => state },
    store: {
      async loadProjects() {
        return { projects: [{ path: PROJECT }], activeProjectKey: PROJECT }
      },
      async validateProjectPath(path) {
        return path
      }
    }
  }
}

test('returns only the exact active registered canonical user Project', async () => {
  const { kernel, store } = harness()
  const resolve = createActiveRegisteredGitProjectResolver(kernel, store)
  assert.equal(await resolve(PROJECT), PROJECT)
})

test('rejects active mismatch, Tasks, unregistered Projects, and canonical drift before Git', async () => {
  {
    const { state, kernel, store } = harness()
    state.activeProjectKey = '/tmp/other'
    await assert.rejects(createActiveRegisteredGitProjectResolver(kernel, store)(PROJECT))
  }
  {
    const { state, kernel, store } = harness()
    state.projects = [{ path: PROJECT, workspaceKind: 'task' }]
    await assert.rejects(createActiveRegisteredGitProjectResolver(kernel, store)(PROJECT))
  }
  {
    const { kernel, store } = harness()
    store.loadProjects = async () => ({ projects: [], activeProjectKey: null })
    await assert.rejects(createActiveRegisteredGitProjectResolver(kernel, store)(PROJECT))
  }
  {
    const { kernel, store } = harness()
    store.validateProjectPath = async () => '/tmp/canonical-drift'
    await assert.rejects(createActiveRegisteredGitProjectResolver(kernel, store)(PROJECT))
  }
  {
    const { state, kernel, store } = harness()
    store.validateProjectPath = async (path) => {
      state.navigatorKind = 'task'
      return path
    }
    await assert.rejects(createActiveRegisteredGitProjectResolver(kernel, store)(PROJECT))
  }
})
