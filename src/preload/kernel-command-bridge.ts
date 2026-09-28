import { isDesktopHostControlIdentity, type DesktopHostControlIdentity } from '../shared/desktop-host-contract.ts'
import type { KernelCommand } from '../shared/kernel-contract.ts'

/** Capture the identity applied by the Renderer, never the latest transport state. */
export function createKernelCommandBridge(
  send: (command: KernelCommand, identity: DesktopHostControlIdentity | null) => Promise<unknown>
) {
  let observedIdentity: DesktopHostControlIdentity | null = null
  return {
    getControlIdentity(): DesktopHostControlIdentity | null {
      return observedIdentity === null ? null : { ...observedIdentity }
    },
    setControlIdentity(identity: DesktopHostControlIdentity | null): void {
      if (identity !== null && !isDesktopHostControlIdentity(identity)) throw new Error('Invalid desktop control identity.')
      observedIdentity = identity === null ? null : { ...identity }
    },
    invoke(command: KernelCommand): Promise<unknown> {
      return send(command, observedIdentity === null ? null : { ...observedIdentity })
    }
  }
}
