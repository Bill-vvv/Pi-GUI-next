import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'

import {
  hasRuntimeProcessExited,
  runtimeProcessSpawnOptions,
  stopRuntimeProcess,
  WINDOWS_RUNTIME_TREE_OWNER_REQUIRED
} from './runtime-process-lifecycle.ts'

function spawnNode(source: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--input-type=module', '--eval', source], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  child.stdout.setEncoding('utf8')
  let output = ''
  await new Promise<void>((resolveReady, rejectReady) => {
    const onData = (chunk: string): void => {
      output += chunk
      if (!output.includes('ready\n')) return
      cleanup()
      resolveReady()
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectReady(error)
    }
    const onClose = (): void => {
      cleanup()
      rejectReady(new Error('Fixture process closed before it was ready.'))
    }
    const cleanup = (): void => {
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
    }
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

async function forceCleanup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (hasRuntimeProcessExited(child)) return
  const close = once(child, 'close')
  child.kill('SIGKILL')
  await close
}

test('runtime process spawn options retain parent ownership and hide the Windows console', () => {
  assert.deepEqual(runtimeProcessSpawnOptions('win32'), {
    detached: false,
    windowsHide: true
  })
  assert.deepEqual(runtimeProcessSpawnOptions('linux'), {
    detached: false,
    windowsHide: false
  })
})

test('Windows Runtime stop succeeds when closing stdin exits the owned process', async (t) => {
  const child = spawnNode(`
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
process.stdout.write('ready\\n')
`)
  t.after(() => forceCleanup(child))
  await waitForReady(child)

  const result = await stopRuntimeProcess(child, { platform: 'win32', graceMs: 200 })

  assert.deepEqual(result, { code: 0, signal: null })
})

test('Windows Runtime stop fails closed instead of claiming unsafe tree termination', async (t) => {
  const child = spawnNode(`
process.stdin.resume()
process.stdin.on('end', () => setInterval(() => undefined, 1_000))
process.stdout.write('ready\\n')
`)
  t.after(() => forceCleanup(child))
  await waitForReady(child)

  await assert.rejects(
    stopRuntimeProcess(child, { platform: 'win32', graceMs: 30 }),
    (error: unknown) => (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === WINDOWS_RUNTIME_TREE_OWNER_REQUIRED
    )
  )
  assert.equal(hasRuntimeProcessExited(child), false)
})

test('POSIX Runtime stop retains bounded SIGTERM then SIGKILL escalation', async (t) => {
  const child = spawnNode(`
process.on('SIGTERM', () => undefined)
process.stdin.resume()
process.stdin.on('end', () => setInterval(() => undefined, 1_000))
process.stdout.write('ready\\n')
`)
  t.after(() => forceCleanup(child))
  await waitForReady(child)

  const result = await stopRuntimeProcess(child, { platform: 'linux', graceMs: 30 })

  assert.equal(result.code, null)
  assert.equal(result.signal, 'SIGKILL')
})
