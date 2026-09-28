import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Missing is distinct from a malformed JSON null document. Never read a FIFO. */
export async function readPrivateDeviceStoreFile(path: string, uid: number, maxBytes: number): Promise<unknown> {
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('Remote device store must be a readable regular non-symlink file.', { cause: error })
  }
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('Remote device store must be a regular file owned by the current user.')
    if (info.uid !== uid) throw new Error('Remote device store must be owned by the current user.')
    if ((info.mode & 0o777) !== 0o600) throw new Error('Remote device store must have mode 0600.')
    if (info.size > maxBytes) throw new Error('Remote device store exceeds the bounded size limit.')
    const bytes = Buffer.alloc(maxBytes + 1)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null)
      if (bytesRead === 0) break
      count += bytesRead
    }
    if (count > maxBytes) throw new Error('Remote device store exceeds the bounded size limit.')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) }
    catch { throw new Error('Remote device store must contain valid UTF-8 JSON.') }
  } finally { await file.close() }
}

/** Only publish a complete private document; report write and cleanup failures. */
export async function writePrivateDeviceStoreFile(path: string, document: unknown, maxBytes: number): Promise<void> {
  const body = `${JSON.stringify(document)}\n`
  if (Buffer.byteLength(body) > maxBytes) throw new Error('Remote device store exceeds the bounded size limit.')
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let closed = false
  try {
    await file.writeFile(body, 'utf8')
    await file.sync()
    await file.close(); closed = true
    await rename(temporary, path)
  } catch (error) {
    const errors = [error]
    if (!closed) { try { await file.close() } catch (cleanup) { errors.push(cleanup) } }
    try { await unlink(temporary) }
    catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(cleanup) }
    if (errors.length > 1) throw new AggregateError(errors, 'Remote device store write and cleanup failed.')
    throw error
  }
  await syncDirectory(dirname(path))
}

export async function removePrivateDeviceStoreFile(path: string): Promise<void> {
  try { await unlink(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  await syncDirectory(dirname(path))
}

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await file.sync() } finally { await file.close() }
}
