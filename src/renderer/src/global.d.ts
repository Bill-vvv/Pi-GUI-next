import type { KernelApi } from '../../shared/kernel-contract'

declare global {
  interface Window {
    piGui: KernelApi
  }
}

export {}
