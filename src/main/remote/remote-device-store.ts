import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const REMOTE_DEVICE_STORE_VERSION = 1 as const
export const REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN = /^[0-9a-f]{64}$/u
const REMOTE_DEVICE_STORE_MAX_BYTES = 4 * 1024

export type RemoteDeviceRecord = {
  credentialHash: string
  pairedAt: number
  expiresAt: number
}

export type RemoteDeviceStore = {
  getDevice(): RemoteDeviceRecord | null
  replaceDevice(record: RemoteDeviceRecord): Promise<void>
  clearDevice(): Promise<void>
}

export function deriveRemoteDeviceStorePath(tokenFile: string): string {
  return `${tokenFile}.device`
}

export function hashRemoteDeviceCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex')
}

export async function openRemoteDeviceStore(options: {
  path: string
  uid: number
}): Promise<RemoteDeviceStore> {
  const storePath = options.path
  let device = await readDeviceStoreFile(storePath, options.uid)
  let writeChain: Promise<void> = Promise.resolve()

  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(operation, operation)
    writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  return {
    getDevice(): RemoteDeviceRecord | null {
      return device === null ? null : { ...device }
    },
    async replaceDevice(record: RemoteDeviceRecord): Promise<void> {
      assertDeviceRecord(record)
      await runExclusive(async () => {
        await writeDeviceStoreFile(storePath, record)
        device = { ...record }
      })
    },
    async clearDevice(): Promise<void> {
      await runExclusive(async () => {
        device = null
        await removeDeviceStoreFile(storePath)
      })
    }
  }
}

async function readDeviceStoreFile(
  storePath: string,
  uid: number
): Promise<RemoteDeviceRecord | null> {
  let file: FileHandle
  try {
    file = await open(storePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNotFound(error)) return null
    throw new Error(
      `Remote device store must be a readable regular non-symlink file: ${errorMessage(error)}`
    )
  }
  try {
    const stats = await file.stat()
    if (!stats.isFile()) {
      throw new Error('Remote device store must be a regular file owned by the current user.')
    }
    if (stats.uid !== uid) {
      throw new Error('Remote device store must be owned by the current user.')
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error('Remote device store must have mode 0600.')
    }
    if (stats.size > REMOTE_DEVICE_STORE_MAX_BYTES) {
      throw new Error('Remote device store exceeds the bounded size limit.')
    }

    const raw = await file.readFile({ encoding: 'utf8' })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      throw new Error('Remote device store must contain valid JSON.')
    }
    return parseDeviceStoreDocument(parsed)
  } finally {
    await file.close()
  }
}

function parseDeviceStoreDocument(value: unknown): RemoteDeviceRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error('Remote device store schema is invalid.')
  }
  const keys = Object.keys(value)
  if (
    keys.length !== 4 ||
    !keys.includes('version') ||
    !keys.includes('credentialHash') ||
    !keys.includes('pairedAt') ||
    !keys.includes('expiresAt')
  ) {
    throw new Error('Remote device store schema is invalid.')
  }
  const document = value as {
    version?: unknown
    credentialHash?: unknown
    pairedAt?: unknown
    expiresAt?: unknown
  }
  if (document.version !== REMOTE_DEVICE_STORE_VERSION) {
    throw new Error('Remote device store version is unsupported.')
  }
  if (
    typeof document.credentialHash !== 'string' ||
    !REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN.test(document.credentialHash)
  ) {
    throw new Error('Remote device store credential hash is invalid.')
  }
  if (!isSafeTimestamp(document.pairedAt) || !isSafeTimestamp(document.expiresAt)) {
    throw new Error('Remote device store timestamps are invalid.')
  }
  if (document.expiresAt <= document.pairedAt) {
    throw new Error('Remote device store expiry must be after pairedAt.')
  }
  return {
    credentialHash: document.credentialHash,
    pairedAt: document.pairedAt,
    expiresAt: document.expiresAt
  }
}

function assertDeviceRecord(record: RemoteDeviceRecord): void {
  parseDeviceStoreDocument({
    version: REMOTE_DEVICE_STORE_VERSION,
    credentialHash: record.credentialHash,
    pairedAt: record.pairedAt,
    expiresAt: record.expiresAt
  })
}

async function writeDeviceStoreFile(
  storePath: string,
  record: RemoteDeviceRecord
): Promise<void> {
  const directory = dirname(storePath)
  const temporaryPath = join(
    directory,
    `.${basename(storePath)}.${randomBytes(8).toString('hex')}.tmp`
  )
  const body = `${JSON.stringify({
    version: REMOTE_DEVICE_STORE_VERSION,
    credentialHash: record.credentialHash,
    pairedAt: record.pairedAt,
    expiresAt: record.expiresAt
  })}\n`

  let file: FileHandle | null = null
  try {
    file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    await file.writeFile(body, 'utf8')
    await file.sync()
    await file.close()
    file = null
    await rename(temporaryPath, storePath)
  } catch (error) {
    if (file !== null) {
      await file.close().catch(() => undefined)
    }
    await unlink(temporaryPath).catch((unlinkError: unknown) => {
      if (!isNotFound(unlinkError)) throw unlinkError
    })
    throw error
  }

  await syncDirectory(directory)
}

async function removeDeviceStoreFile(storePath: string): Promise<void> {
  try {
    await unlink(storePath)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  await syncDirectory(dirname(storePath))
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY
  )
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
