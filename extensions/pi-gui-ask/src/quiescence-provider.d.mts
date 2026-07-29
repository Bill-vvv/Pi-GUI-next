export type OperationLeaseController = {
  startSession: () => number
  endSession: () => void
  beginOperation: () => (() => void) | null
  activeCount: () => number
  isFrozen: () => boolean
  prepare: (identity: unknown) => boolean
  commit: (identity: unknown) => boolean
  release: (identity: unknown) => boolean
}

export function createOperationLeaseController(): OperationLeaseController

export function installOperationLeaseProvider(
  events: unknown,
  providerId: string,
  controller: OperationLeaseController
): boolean
