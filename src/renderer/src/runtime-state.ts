import type { RuntimeStatus } from '../../shared/kernel-contract'

export function canChangeRuntimeContext(status: RuntimeStatus): boolean {
  return status === 'stopped' || status === 'ready' || status === 'crashed'
}

export function canStartRuntime(status: RuntimeStatus): boolean {
  return status === 'stopped' || status === 'crashed'
}
