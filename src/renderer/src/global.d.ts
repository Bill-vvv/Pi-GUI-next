import type { GitApi } from '../../shared/git-contract'
import type { KernelApi } from '../../shared/kernel-contract'
import type { RemoteAdminApi } from '../../shared/remote-admin-contract'
import type { DesktopClientApi } from '../../shared/desktop-client-contract'

declare global {
  interface Window {
    piGui: KernelApi
    piGit: GitApi
    piRemote: RemoteAdminApi
    piDesktopClient?: DesktopClientApi
  }
}

export {}
