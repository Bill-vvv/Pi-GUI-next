import { parseLegacyRemoteDeviceDocument, parseRemoteDeviceRecord, REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN, type RemoteDeviceRecord } from './remote-device-store.ts'
import { readPrivateDeviceStoreFile, writePrivateDeviceStoreFile } from './private-device-store-file.ts'

export const DESKTOP_DEVICE_STORE_VERSION = 2 as const
export const DESKTOP_DEVICE_LIMIT = 8
export const DESKTOP_DEVICE_LABEL_LIMIT = 80
export const DESKTOP_DEVICE_STORE_MAX_BYTES = 16 * 1024

export type DesktopDeviceRecord = RemoteDeviceRecord & { label: string | null }
export type DesktopDeviceStore = {
  getDevices(): DesktopDeviceRecord[]
  addDevice(record: DesktopDeviceRecord): Promise<void>
  revokeDevice(credentialHash: string): Promise<void>
}

function parseDevice(value: unknown): DesktopDeviceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 ||
      !('credentialHash' in value) || !('pairedAt' in value) || !('expiresAt' in value) || !('label' in value)) throw new Error('Desktop device record schema is invalid.')
  const record = parseRemoteDeviceRecord({ credentialHash: value.credentialHash, pairedAt: value.pairedAt, expiresAt: value.expiresAt })
  const label = value.label
  if (label !== null && (typeof label !== 'string' || label.length === 0 || label.length > DESKTOP_DEVICE_LABEL_LIMIT ||
      label.trim() !== label || /[\u0000-\u001f\u007f]/u.test(label))) throw new Error('Desktop device label is invalid.')
  return { ...record, label }
}

/** Read-only schema validation, shared with release compatibility checks. */
export function parseDesktopDeviceStoreDocument(document: unknown): { version: 1 | 2; devices: DesktopDeviceRecord[] } {
  if (document === null || typeof document !== 'object' || Array.isArray(document) || !('version' in document)) throw new Error('Desktop device store schema is invalid.')
  if (document.version === 1) return { version: 1, devices: [{ ...parseLegacyRemoteDeviceDocument(document), label: null }] }
  if (document.version !== DESKTOP_DEVICE_STORE_VERSION || Object.keys(document).length !== 2 ||
      !('devices' in document) || !Array.isArray(document.devices) || document.devices.length > DESKTOP_DEVICE_LIMIT) throw new Error('Desktop device store schema or capacity is invalid.')
  const devices = document.devices.map(parseDevice)
  if (new Set(devices.map(device => device.credentialHash)).size !== devices.length) throw new Error('Desktop device store contains duplicate credentials.')
  return { version: DESKTOP_DEVICE_STORE_VERSION, devices }
}

/** A Desktop-only collection. Web Remote keeps its independent version-1 store. */
export async function openDesktopDeviceStore(options: { path: string; uid: number; now?: () => number }): Promise<DesktopDeviceStore> {
  const storePath = options.path
  const now = options.now ?? Date.now
  const document = await readPrivateDeviceStoreFile(storePath, options.uid, DESKTOP_DEVICE_STORE_MAX_BYTES)
  let devices: DesktopDeviceRecord[] = []
  if (document !== undefined) {
    const parsed = parseDesktopDeviceStoreDocument(document)
    devices = parsed.devices
    if (parsed.version === 1) {
      // Preserve the existing hash and dates, including expired records; only a
      // successful atomic migration may make this collection available to Main.
      await writePrivateDeviceStoreFile(storePath, { version: DESKTOP_DEVICE_STORE_VERSION, devices }, DESKTOP_DEVICE_STORE_MAX_BYTES)
    }
  }
  let writes: Promise<void> = Promise.resolve()
  const exclusive = (operation: () => Promise<void>): Promise<void> => {
    const pending = writes.then(operation, operation)
    // Keep the queue usable after a rejected write; its caller receives rejection.
    writes = pending.then(() => undefined, () => undefined)
    return pending
  }
  return {
    getDevices: () => devices.map(device => ({ ...device })),
    async addDevice(record) {
      const value = parseDevice(record)
      await exclusive(async () => {
        const time = now()
        if (!Number.isSafeInteger(time) || time < 0) throw new Error('Desktop device store clock is invalid.')
        if (value.pairedAt > time || value.expiresAt <= time) throw new Error('Desktop device must be currently valid when paired.')
        if (devices.some(device => device.credentialHash === value.credentialHash)) throw new Error('Desktop device credential already exists.')
        const current = devices.filter(device => device.expiresAt > time)
        if (current.length >= DESKTOP_DEVICE_LIMIT) throw new Error(`Desktop Host already has ${DESKTOP_DEVICE_LIMIT} paired devices. Revoke a device before pairing another.`)
        const next = [...current, value]
        await writePrivateDeviceStoreFile(storePath, { version: DESKTOP_DEVICE_STORE_VERSION, devices: next }, DESKTOP_DEVICE_STORE_MAX_BYTES)
        devices = next
      })
    },
    async revokeDevice(credentialHash) {
      if (typeof credentialHash !== 'string' || !REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN.test(credentialHash)) throw new Error('Desktop device credential hash is invalid.')
      await exclusive(async () => {
        // Deny this device immediately, even when the disk operation fails. A
        // repeated revoke still persists, so it can repair that failed operation.
        devices = devices.filter(device => device.credentialHash !== credentialHash)
        await writePrivateDeviceStoreFile(storePath, { version: DESKTOP_DEVICE_STORE_VERSION, devices }, DESKTOP_DEVICE_STORE_MAX_BYTES)
      })
    }
  }
}
