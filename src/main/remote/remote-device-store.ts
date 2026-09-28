import { createHash } from 'node:crypto'
import { readPrivateDeviceStoreFile, writePrivateDeviceStoreFile, removePrivateDeviceStoreFile } from './private-device-store-file.ts'

export const REMOTE_DEVICE_STORE_VERSION = 1 as const
export const REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN = /^[0-9a-f]{64}$/u
export const REMOTE_DEVICE_STORE_MAX_BYTES = 4 * 1024

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
  const document = await readPrivateDeviceStoreFile(storePath, options.uid, REMOTE_DEVICE_STORE_MAX_BYTES)
  let device = document === undefined ? null : parseLegacyRemoteDeviceDocument(document)
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
      const value = parseRemoteDeviceRecord(record)
      await runExclusive(async () => {
        await writePrivateDeviceStoreFile(storePath, { version: REMOTE_DEVICE_STORE_VERSION, ...value }, REMOTE_DEVICE_STORE_MAX_BYTES)
        device = value
      })
    },
    async clearDevice(): Promise<void> {
      await runExclusive(async () => {
        device = null
        await removePrivateDeviceStoreFile(storePath)
      })
    }
  }
}

export function parseLegacyRemoteDeviceDocument(value: unknown): RemoteDeviceRecord {
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
  return parseRemoteDeviceRecord({ credentialHash: document.credentialHash, pairedAt: document.pairedAt, expiresAt: document.expiresAt })
}

export function parseRemoteDeviceRecord(value: unknown): RemoteDeviceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      !('credentialHash' in value) || !('pairedAt' in value) || !('expiresAt' in value)) throw new Error('Remote device record schema is invalid.')
  const record = value as Record<string, unknown>
  if (
    typeof record.credentialHash !== 'string' ||
    !REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN.test(record.credentialHash)
  ) {
    throw new Error('Remote device store credential hash is invalid.')
  }
  if (!isSafeTimestamp(record.pairedAt) || !isSafeTimestamp(record.expiresAt)) {
    throw new Error('Remote device store timestamps are invalid.')
  }
  if (record.expiresAt <= record.pairedAt) {
    throw new Error('Remote device store expiry must be after pairedAt.')
  }
  return {
    credentialHash: record.credentialHash,
    pairedAt: record.pairedAt,
    expiresAt: record.expiresAt
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
