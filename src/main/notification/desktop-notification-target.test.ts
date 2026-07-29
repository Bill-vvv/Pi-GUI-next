import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProjectSessionRegistry, SessionPointer } from '../project/session-pointer.ts'
import {
  activateDesktopNotificationTarget,
  type DesktopNotificationKernel,
  type DesktopNotificationProjectStore
} from './desktop-notification-target.ts'

const PROJECT = '/tmp/project'
const SESSION = '/tmp/session.jsonl'
const POINTER: SessionPointer = {
  projectPath: PROJECT,
  sessionFile: SESSION,
  sessionId: 'session-1',
  sessionName: 'Session'
}

function registry(sessions: SessionPointer[]): ProjectSessionRegistry {
  return { sessions, activeSessionKey: sessions[0]?.sessionFile ?? null }
}

test('activation retries a provisional registration and then selects Project before Session', async () => {
  let registryReads = 0
  const events: string[] = []
  const projectStore: DesktopNotificationProjectStore = {
    async validateProjectPath(path) {
      assert.equal(path, PROJECT)
      return PROJECT
    },
    async loadSessionRegistry() {
      registryReads += 1
      return registry(registryReads < 3 ? [] : [POINTER])
    },
    async validateSession(pointer) {
      assert.deepEqual(pointer, POINTER)
      return pointer
    }
  }
  const kernel: DesktopNotificationKernel = {
    getState: () => ({ activeProjectKey: '/tmp/other-project' }),
    async activateProject(path) {
      events.push(`project:${path}`)
    },
    async activateSession(sessionKey) {
      events.push(`session:${sessionKey}`)
    }
  }

  await activateDesktopNotificationTarget(
    { projectPath: PROJECT, sessionKey: SESSION },
    {
      projectStore,
      kernel,
      isAvailable: () => true,
      focusWindow: () => events.push('focus'),
      retryAttempts: 3,
      retryDelayMs: 0,
      wait: async () => {}
    }
  )

  assert.equal(registryReads, 3)
  assert.deepEqual(events, [
    'focus',
    `project:${PROJECT}`,
    `session:${SESSION}`,
    'focus'
  ])
})

test('Task notification activation selects the typed Task owner instead of a hidden Project', async () => {
  const events: string[] = []
  const projectStore: DesktopNotificationProjectStore = {
    async validateProjectPath(path) {
      return path
    },
    async loadSessionRegistry() {
      return registry([POINTER])
    },
    async validateSession(pointer) {
      return pointer
    }
  }
  const kernel: DesktopNotificationKernel = {
    getState: () => ({
      activeProjectKey: '/tmp/other-project',
      projects: [
        { path: '/tmp/other-project' },
        { path: PROJECT, workspaceKind: 'task', taskKey: 'task-1' }
      ]
    }),
    async activateProject() {
      assert.fail('Task target must not activate as a Project')
    },
    async activateTask(taskKey) {
      events.push(`task:${taskKey}`)
    },
    async activateSession(sessionKey) {
      events.push(`session:${sessionKey}`)
    }
  }

  await activateDesktopNotificationTarget(
    { projectPath: PROJECT, sessionKey: SESSION },
    {
      projectStore,
      kernel,
      isAvailable: () => true,
      focusWindow: () => events.push('focus')
    }
  )

  assert.deepEqual(events, ['focus', 'task:task-1', `session:${SESSION}`, 'focus'])
})

test('invalid or stale notification targets never focus the window', async () => {
  let focusCount = 0
  let activationCount = 0
  const projectStore: DesktopNotificationProjectStore = {
    async validateProjectPath() {
      return PROJECT
    },
    async loadSessionRegistry() {
      return registry([])
    },
    async validateSession(pointer) {
      return pointer
    }
  }
  const kernel: DesktopNotificationKernel = {
    getState: () => ({ activeProjectKey: PROJECT }),
    async activateProject() {
      activationCount += 1
    },
    async activateSession() {
      activationCount += 1
    }
  }

  await assert.rejects(
    activateDesktopNotificationTarget(
      { projectPath: PROJECT, sessionKey: SESSION },
      {
        projectStore,
        kernel,
        isAvailable: () => true,
        focusWindow: () => { focusCount += 1 },
        retryAttempts: 1,
        retryDelayMs: 0,
        wait: async () => {}
      }
    ),
    /not registered/u
  )
  assert.equal(focusCount, 0)
  assert.equal(activationCount, 0)
})

test('activation retries a transient ENOENT while validating the exact Session file', async () => {
  let validationCount = 0
  const projectStore: DesktopNotificationProjectStore = {
    async validateProjectPath() {
      return PROJECT
    },
    async loadSessionRegistry() {
      return registry([POINTER])
    },
    async validateSession(pointer) {
      validationCount += 1
      if (validationCount === 1) {
        const error = new Error('not materialized') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return pointer
    }
  }
  let activeSession: string | null = null
  await activateDesktopNotificationTarget(
    { projectPath: PROJECT, sessionKey: SESSION },
    {
      projectStore,
      kernel: {
        getState: () => ({ activeProjectKey: PROJECT }),
        async activateProject() {},
        async activateSession(sessionKey) {
          activeSession = sessionKey
        }
      },
      isAvailable: () => true,
      focusWindow: () => {},
      retryAttempts: 1,
      retryDelayMs: 0,
      wait: async () => {}
    }
  )
  assert.equal(validationCount, 2)
  assert.equal(activeSession, SESSION)
})
