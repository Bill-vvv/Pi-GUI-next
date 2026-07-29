import { readFile } from 'node:fs/promises'

/**
 * Canonical root-process memory sample from Linux `/proc/<pid>/smaps_rollup`.
 * Values are bytes. Descendants are intentionally not aggregated.
 */
export type LinuxProcessMemoryBytes = {
  rssBytes: number
  pssBytes: number
}

export type LinuxProcessMemoryUnavailableReason =
  | 'platform-unsupported'
  | 'invalid-pid'
  | 'process-gone'
  | 'smaps-unreadable'

export type LinuxProcessMemoryReadResult =
  | { ok: true; memory: LinuxProcessMemoryBytes }
  | { ok: false; reason: LinuxProcessMemoryUnavailableReason }

/** Largest kibibyte count whose byte product stays in Number.MAX_SAFE_INTEGER. */
const MAX_SAFE_KIBIBYTES = Math.floor(Number.MAX_SAFE_INTEGER / 1024)

/**
 * Read RSS/PSS for a single process from `/proc/<pid>/smaps_rollup`.
 * Ownership is root-only: callers must not sum children unless they document a
 * separate ownership model and expose it as an explicit field.
 */
export async function readLinuxProcessMemoryBytes(
  pid: number
): Promise<LinuxProcessMemoryReadResult> {
  if (process.platform !== 'linux') {
    return { ok: false, reason: 'platform-unsupported' }
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: 'invalid-pid' }
  }

  try {
    const smaps = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
    const rssBytes = smapsFieldBytes(smaps, 'Rss')
    const pssBytes = smapsFieldBytes(smaps, 'Pss')
    if (rssBytes === null || pssBytes === null) {
      return { ok: false, reason: 'smaps-unreadable' }
    }
    return { ok: true, memory: { rssBytes, pssBytes } }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ESRCH') {
      return { ok: false, reason: 'process-gone' }
    }
    return { ok: false, reason: 'smaps-unreadable' }
  }
}

/** Parse one smaps_rollup field. Linux reports kibibytes; convert to bytes. */
export function smapsFieldBytes(text: string, field: 'Rss' | 'Pss'): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)
  if (match === null) return null
  const kibibytes = Number(match[1])
  if (!Number.isSafeInteger(kibibytes) || kibibytes < 0 || kibibytes > MAX_SAFE_KIBIBYTES) {
    return null
  }
  const bytes = kibibytes * 1024
  if (!Number.isSafeInteger(bytes)) {
    return null
  }
  return bytes
}
