import { createHash } from 'node:crypto'

import { DESKTOP_HOST_CREDENTIAL_PATTERN } from '../../shared/desktop-host-contract.ts'
import { hashRemoteDeviceCredential, REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN } from './remote-device-store.ts'

/** Public pairing identity is separate from both the token and its authentication hash. */
export function desktopPairingIdFromHash(credentialHash: string): string {
  if (!REMOTE_DEVICE_CREDENTIAL_HASH_PATTERN.test(credentialHash)) throw new Error('Invalid Desktop device credential hash.')
  return createHash('sha256').update(`pi-gui-desktop-pairing-id-v1\0${credentialHash}`, 'utf8').digest('hex')
}

export function desktopPairingId(credential: string): string {
  if (!DESKTOP_HOST_CREDENTIAL_PATTERN.test(credential)) throw new Error('Invalid Desktop device credential.')
  return desktopPairingIdFromHash(hashRemoteDeviceCredential(credential))
}
