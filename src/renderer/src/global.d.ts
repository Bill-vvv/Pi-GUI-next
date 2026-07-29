import type { GitApi } from '../../shared/git-contract'
import type { KernelApi } from '../../shared/kernel-contract'

declare global {
  interface Window {
    piGui: KernelApi
    piGit: GitApi
  }
}

export {}
