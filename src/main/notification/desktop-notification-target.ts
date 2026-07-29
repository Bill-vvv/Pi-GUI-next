import type { ProjectSessionRegistry, SessionPointer } from '../project/session-pointer.ts'
import type { DesktopNotificationTarget } from './desktop-notification-broker.ts'

const DEFAULT_RETRY_ATTEMPTS = 20
const DEFAULT_RETRY_DELAY_MS = 50

export type DesktopNotificationProjectStore = {
  validateProjectPath(path: string): Promise<string>
  loadSessionRegistry(projectPath: string): Promise<ProjectSessionRegistry>
  validateSession(pointer: SessionPointer): Promise<SessionPointer>
}

export type DesktopNotificationKernel = {
  getState(): {
    activeProjectKey: string | null
    projects?: Array<{
      path: string
      workspaceKind?: 'project' | 'task'
      taskKey?: string
    }>
  }
  activateProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void>
  activateTask?(taskKey: string, sessionRegistry: ProjectSessionRegistry): Promise<void>
  activateSession(sessionKey: string): Promise<void>
}

export type DesktopNotificationActivationOptions = {
  projectStore: DesktopNotificationProjectStore
  kernel: DesktopNotificationKernel
  isAvailable(): boolean
  focusWindow(): void
  retryAttempts?: number
  retryDelayMs?: number
  wait?(delayMs: number): Promise<void>
}

export async function activateDesktopNotificationTarget(
  target: DesktopNotificationTarget,
  options: DesktopNotificationActivationOptions
): Promise<void> {
  if (!options.isAvailable()) throw new Error('Pi GUI is shutting down.')
  const resolved = await resolveTargetWithRetry(target, options)
  if (!options.isAvailable()) throw new Error('Pi GUI is shutting down.')

  // Focus only after identity validation. The target Runtime already exists because
  // it emitted the notification, so this also makes any activation UI visible.
  options.focusWindow()
  const state = options.kernel.getState()
  if (state.activeProjectKey !== resolved.target.projectPath) {
    const workspace = state.projects?.find(({ path }) => path === resolved.target.projectPath)
    if (workspace?.workspaceKind === 'task') {
      if (workspace.taskKey === undefined || options.kernel.activateTask === undefined) {
        throw new Error('Notification Task target is unavailable.')
      }
      await options.kernel.activateTask(workspace.taskKey, resolved.sessionRegistry)
    } else {
      await options.kernel.activateProject(resolved.target.projectPath, resolved.sessionRegistry)
    }
  }
  if (!options.isAvailable()) throw new Error('Pi GUI is shutting down.')
  await options.kernel.activateSession(resolved.target.sessionKey)
  options.focusWindow()
}

async function resolveTargetWithRetry(
  target: DesktopNotificationTarget,
  options: DesktopNotificationActivationOptions
): Promise<{
  target: DesktopNotificationTarget
  sessionRegistry: ProjectSessionRegistry
}> {
  const canonicalProjectPath = await options.projectStore.validateProjectPath(target.projectPath)
  if (canonicalProjectPath !== target.projectPath) {
    throw new Error('Notification project path no longer resolves canonically.')
  }
  const retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const wait = options.wait ?? defaultWait
  if (!Number.isInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 100) {
    throw new Error('Desktop notification retry attempts are invalid.')
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1_000) {
    throw new Error('Desktop notification retry delay is invalid.')
  }

  for (let attempt = 0; ; attempt += 1) {
    if (!options.isAvailable()) throw new Error('Pi GUI is shutting down.')
    try {
      return await resolveRegisteredSession(
        options.projectStore,
        canonicalProjectPath,
        target.sessionKey
      )
    } catch (error) {
      if (!isPendingRegistration(error) || attempt >= retryAttempts) throw error
      await wait(retryDelayMs)
    }
  }
}

async function resolveRegisteredSession(
  projectStore: DesktopNotificationProjectStore,
  canonicalProjectPath: string,
  sessionKey: string
): Promise<{
  target: DesktopNotificationTarget
  sessionRegistry: ProjectSessionRegistry
}> {
  const sessionRegistry = await projectStore.loadSessionRegistry(canonicalProjectPath)
  const pointer = sessionRegistry.sessions.find((candidate) =>
    candidate.projectPath === canonicalProjectPath && candidate.sessionFile === sessionKey
  )
  if (pointer === undefined) {
    throw new PendingNotificationRegistrationError()
  }
  let validatedPointer: SessionPointer
  try {
    validatedPointer = await projectStore.validateSession(pointer)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new PendingNotificationRegistrationError()
    }
    throw error
  }
  if (validatedPointer.sessionFile !== sessionKey) {
    throw new Error('Notification Session path no longer resolves canonically.')
  }
  return {
    target: { projectPath: canonicalProjectPath, sessionKey: validatedPointer.sessionFile },
    sessionRegistry
  }
}

class PendingNotificationRegistrationError extends Error {
  constructor() {
    super('Notification Session is not registered for the Project.')
    this.name = 'PendingNotificationRegistrationError'
  }
}

function isPendingRegistration(error: unknown): error is PendingNotificationRegistrationError {
  return error instanceof PendingNotificationRegistrationError
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
