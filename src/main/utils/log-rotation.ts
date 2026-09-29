import { rename, stat } from 'node:fs/promises'

/** Keep one previous generation: move a log above maxBytes to `<path>.1` before appending. */
export async function rotateLogIfLarger(path: string, maxBytes: number): Promise<void> {
  try {
    if ((await stat(path)).size <= maxBytes) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await rename(path, `${path}.1`)
}
