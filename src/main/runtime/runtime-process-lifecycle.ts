import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'

const DEFAULT_STOP_GRACE_MS = 1_000

export const WINDOWS_RUNTIME_TREE_OWNER_REQUIRED = 'E_WINDOWS_RUNTIME_TREE_OWNER_REQUIRED'

export type RuntimeProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type StopRuntimeProcessOptions = {
  platform?: NodeJS.Platform
  graceMs?: number
}

export function runtimeProcessSpawnOptions(
  platform: NodeJS.Platform = process.platform
): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
  return {
    detached: false,
    windowsHide: platform === 'win32'
  }
}

export async function stopRuntimeProcess(
  child: ChildProcessWithoutNullStreams,
  options: StopRuntimeProcessOptions = {}
): Promise<RuntimeProcessExit> {
  if (hasRuntimeProcessExited(child)) {
    return processExit(child)
  }

  const graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS
  if (!Number.isInteger(graceMs) || graceMs < 1) {
    throw new Error('Runtime process stop grace must be a positive integer.')
  }

  child.stdin.end()
  if (await waitForExit(child, graceMs)) {
    return processExit(child)
  }

  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (hasRuntimeProcessExited(child)) return processExit(child)
    const error = new Error(
      'Windows Pi RPC process did not exit after stdin close. ' +
      'Safe forced process-tree termination requires a Windows Job Object owner.'
    ) as NodeJS.ErrnoException
    error.code = WINDOWS_RUNTIME_TREE_OWNER_REQUIRED
    throw error
  }

  child.kill('SIGTERM')
  if (await waitForExit(child, graceMs)) {
    return processExit(child)
  }

  child.kill('SIGKILL')
  if (await waitForExit(child, graceMs)) {
    return processExit(child)
  }

  throw new Error('Pi RPC process did not exit after stdin close, SIGTERM, and SIGKILL.')
}

export function hasRuntimeProcessExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function processExit(child: ChildProcessWithoutNullStreams): RuntimeProcessExit {
  return { code: child.exitCode, signal: child.signalCode }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasRuntimeProcessExited(child)) {
    return Promise.resolve(true)
  }

  return new Promise((resolveWait) => {
    const onClose = (): void => {
      clearTimeout(timer)
      resolveWait(true)
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolveWait(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}
