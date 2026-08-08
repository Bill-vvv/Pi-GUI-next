import { REMOTE_PAIRING_CODE_LENGTH } from '../shared/remote-contract.ts'

export function normalizePairingCodeInput(value: string): string {
  return value.replace(/\D/gu, '').slice(0, REMOTE_PAIRING_CODE_LENGTH)
}

export function isCompletePairingCode(value: string): boolean {
  return new RegExp(`^\\d{${REMOTE_PAIRING_CODE_LENGTH}}$`, 'u').test(value)
}
