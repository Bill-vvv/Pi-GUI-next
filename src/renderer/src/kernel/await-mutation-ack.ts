import type { KernelMutationAck } from '../../../shared/kernel-contract.ts'
import { parseKernelMutationAck } from './kernel-revision-barrier.ts'

export type MutationAckBarrier = {
  waitForAck(value: unknown): Promise<KernelMutationAck>
}

/**
 * Production helper for Kernel mutation invokes.
 * Requires a typed KernelMutationAck (or superseding domain result) and settles
 * only after the barrier applies that revision. Stale full-state or bare numbers reject.
 */
export async function awaitMutationAck<T extends KernelMutationAck>(
  operation: () => Promise<T>,
  barrier: MutationAckBarrier | null
): Promise<T> {
  const result = await operation()
  if (barrier === null) {
    parseKernelMutationAck(result)
    return result
  }
  await barrier.waitForAck(result)
  return result
}
