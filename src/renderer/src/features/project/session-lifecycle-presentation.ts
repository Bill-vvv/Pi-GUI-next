import type { KernelState } from '../../../../shared/kernel-contract'

export function sessionLifecycleLabel(
  status: KernelState['runtime']['status']
): string | null {
  if (status === 'running') return '正在处理'
  if (status === 'stopping') return '正在收尾'
  return null
}
