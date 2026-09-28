import { parseDesktopDeviceStoreDocument, DESKTOP_DEVICE_STORE_MAX_BYTES } from './desktop-device-store.ts'
import { REMOTE_DEVICE_STORE_MAX_BYTES } from './remote-device-store.ts'
import { readPrivateDeviceStoreFile } from './private-device-store-file.ts'

/** Called only after package.json has passed the build artifact verification. */
export function desktopHostDeviceStoreVersions(pkg: Record<string, unknown>): Array<1 | 2> {
  // Historical builds predate this field and have the version-1 reader. An
  // explicit malformed declaration must never be mistaken for that legacy case.
  if (!Object.hasOwn(pkg, 'desktopHost')) return [1]
  const declaration = pkg.desktopHost
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration) || Object.keys(declaration).length !== 1 ||
      !('deviceStoreVersions' in declaration) || !Array.isArray(declaration.deviceStoreVersions)) throw new Error('Invalid Host device store compatibility declaration.')
  const versions = declaration.deviceStoreVersions
  if (versions.length === 0 || versions.length > 2 || versions.some(version => version !== 1 && version !== 2) ||
      versions.some((version, index) => index > 0 && version <= versions[index - 1])) throw new Error('Invalid Host device store compatibility declaration.')
  return [...versions]
}

/** Inspect, never migrate, credentials before selecting or launching a release. */
export async function assertDesktopHostDeviceStoreCompatible(path: string, versions: readonly (1 | 2)[]): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Host device store compatibility requires Linux ownership checks.')
  const document = await readPrivateDeviceStoreFile(path, uid,
    versions.includes(2) ? DESKTOP_DEVICE_STORE_MAX_BYTES : REMOTE_DEVICE_STORE_MAX_BYTES)
  if (document === undefined) return
  const parsed = parseDesktopDeviceStoreDocument(document)
  if (!versions.includes(parsed.version)) throw new Error(`This Host release cannot read device store format ${parsed.version}. Use a compatible release; keep the existing pairing data.`)
}
