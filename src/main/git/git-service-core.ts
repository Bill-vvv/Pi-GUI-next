import type {
  GitPushTarget,
  GitRefreshResult,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import type { RunOptions } from './git-service-types.ts'
import type { GitServiceTestHooks, ResolvedOptions, SerialQueue } from './git-service.ts'

/**
 * The shared repository operations GitService lends to its domain modules (D-098).
 * Every member is bound to the owning GitService; domain modules never reach its other state.
 */
export type GitServiceCore = {
  readonly options: ResolvedOptions
  readonly testHooks: GitServiceTestHooks
  readonly branchCapabilitySecret: Buffer
  runRaw(cwd: string, args: string[], options: RunOptions): Promise<string>
  refresh(signal?: AbortSignal): Promise<GitRepositoryState>
  refreshSafe(signal?: AbortSignal): Promise<GitRefreshResult>
  safeRefresh(): Promise<GitRepositoryState | null>
  resolveQueue(repositoryRoot: string): SerialQueue
  readPushTarget(repositoryRoot: string, branch: string, signal?: AbortSignal): Promise<GitPushTarget | null>
  readUpstreamTrackingRef(repositoryRoot: string, branch: string, signal?: AbortSignal): Promise<string>
}
