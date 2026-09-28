import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiRuntimeProcessHost } from './pi-runtime-process-host.ts'

export type PiRuntimeProbeResult = {
  version: string | null
  commandCount: number
  pid: number | null
}

/**
 * Smoke check of the real Pi Runtime process path (D-098): start the shared process, start
 * one Session with the app-owned Extensions, read its commands and stop. Uses a temporary
 * agent directory and offline mode so the user's Pi sessions and settings are untouched.
 */
export async function probePiRuntimeProcess(options: {
  entryPath: string
  extensionPaths: string[]
  quiescenceExtensionPath?: string
  piExecutable?: string
}): Promise<PiRuntimeProbeResult> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-runtime-probe-'))
  const host = new PiRuntimeProcessHost({
    entryPath: options.entryPath,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: join(root, 'agent'),
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1'
    }
  })
  try {
    const runtime = host.createRuntime({
      cwd: root,
      extensionPaths: options.extensionPaths,
      ...(options.quiescenceExtensionPath === undefined ? {} : { quiescenceExtensionPath: options.quiescenceExtensionPath }),
      ...(options.piExecutable === undefined ? {} : { piExecutable: options.piExecutable })
    })
    await runtime.start()
    const pid = host.getPid()
    const result = await runtime.send({ type: 'get_commands' })
    if (result.type !== 'commands') throw new Error('Pi Runtime probe received an unexpected command result.')
    const version = runtime.getState().version
    await runtime.stop()
    await host.dispose()
    return { version, commandCount: result.commands.length, pid }
  } finally {
    await host.dispose().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}
