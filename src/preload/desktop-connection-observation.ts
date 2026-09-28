import type { DesktopClientStatus } from '../shared/desktop-client-contract.ts'

/** Keep the latest Main connection status; late status reads cannot restore an old connection. */
export function createDesktopConnectionObservation() {
  let sequence = 0
  let current: DesktopClientStatus | null = null
  return {
    apply(status: DesktopClientStatus): void { sequence++; current = structuredClone(status) },
    connectionId(): string | null {
      return current?.mode === 'windows-remote' && current.phase === 'connected' ? current.hostConnectionId ?? null : null
    },
    async read(fetchStatus: () => Promise<DesktopClientStatus>): Promise<DesktopClientStatus> {
      const observed = sequence
      const result = await fetchStatus()
      if (observed === sequence) { sequence++; current = structuredClone(result) }
      return structuredClone(current!)
    }
  }
}
