import { execFile, spawn } from 'node:child_process'
import type { KernelCommand } from '../../shared/kernel-contract.ts'
import { WslPipe } from './wsl-pipe.ts'

export async function mapWslAttachments(command: KernelCommand, resolvePath: (path: string) => Promise<string>): Promise<KernelCommand> {
  if ((command.type !== 'kernel.prompt' && command.type !== 'kernel.steer' && command.type !== 'kernel.follow-up') || command.attachments === undefined) return command
  return { ...command, attachments: await Promise.all(command.attachments.map(async (attachment) => {
    // Clipboard images may have only a display name; actual file paths need mapping.
    if (attachment.path.startsWith('/') || (attachment.type === 'image' && !/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(attachment.path))) return attachment
    return { ...attachment, path: await resolvePath(attachment.path) }
  })) }
}

export async function resolveWslFilePath(distribution: string, path: string): Promise<string> {
  if (/[\u0000-\u001f\u007f]/u.test(path)) throw new Error('Invalid attachment path.')
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/iu.exec(path)
  if (unc !== null) {
    if (unc[1]!.toLowerCase() !== distribution.toLowerCase()) throw new Error('Attachment belongs to a different WSL distribution.')
    return `/${unc[2]!.replaceAll('\\', '/')}`
  }
  if (!/^[A-Za-z]:[\\/]/u.test(path)) throw new Error('Attachment must be an absolute Windows or WSL file path.')
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', ['--distribution', distribution, '--exec', 'wslpath', '-a', '-u', path], {
      windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      if (error !== null) { reject(new Error('Cannot map the attachment path into WSL.')); return }
      const mapped = stdout.trim()
      if (!mapped.startsWith('/') || /[\r\n\u0000]/u.test(mapped)) { reject(new Error('WSL returned an invalid attachment path.')); return }
      resolve(mapped)
    })
  })
}

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
