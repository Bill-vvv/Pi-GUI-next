import { spawn } from 'node:child_process'
import { WslPipe } from './wsl-pipe.ts'

export async function startWslBackend(options: {
  distribution: string
  launcherPath: string
  fingerprint: string
  onEvent(channel: string, value: unknown): void
  onDiagnostic(chunk: Buffer): void
}): Promise<{ pipe: WslPipe; close(): Promise<void> }> {
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,127}$/u.test(options.distribution)) throw new Error('Invalid WSL distribution name.')
  if (!options.launcherPath.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(options.launcherPath)) {
    throw new Error('WSL launcher must be an absolute Linux path.')
  }
  const child = spawn('wsl.exe', ['--distribution', options.distribution, '--exec', options.launcherPath], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
  child.stderr.on('data', options.onDiagnostic)
  const pipe = new WslPipe({
    input: child.stdout,
    output: child.stdin,
    fingerprint: options.fingerprint,
    expectedPlatform: 'linux',
    onEvent: options.onEvent
  })
  child.once('error', () => pipe.close())
  let closing: Promise<void> | null = null
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // EOF belongs to this one child. The Linux host drains its kernel on EOF.
      pipe.close()
      let timer: ReturnType<typeof setTimeout> | undefined
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 15_000) })
      ])
      clearTimeout(timer)
      if (!stopped) {
        child.kill()
        throw new Error('WSL backend did not finish shutting down within 15 seconds. Check the WSL backend log before restarting.')
      }
    })()
    return closing
  }
  try {
    await pipe.ready
  } catch (error) {
    await close()
    throw error
  }
  return { pipe, close }
}
