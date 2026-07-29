export const LEASE_COORDINATOR_STATES: readonly ['open', 'draining', 'prepared', 'committed']
export const MAX_LEASE_ID_LENGTH: 128
export const MAX_LEASE_TOKEN_SUFFIX_LENGTH: 64
export const MAX_REGISTERED_OWNER_COUNT: 32
export const MAX_REQUIRED_EXTENSION_COUNT: 32
export const MAX_ACTIVE_WORK_COUNT: 256

export type LeaseCoordinatorState = (typeof LEASE_COORDINATOR_STATES)[number]
export type LeaseTokenKind = 'work' | 'prepare' | 'hibernation'
export type LeaseFailureReason =
  | 'runtime-mismatch'
  | 'invalid-owner-registration'
  | 'owner-registration-closed'
  | 'owner-registration-conflict'
  | 'owner-count-limit'
  | 'invalid-work-holder'
  | 'work-holder-conflict'
  | 'admission-closed'
  | 'unknown-owner'
  | 'work-count-limit'
  | 'token-sequence-exhausted'
  | 'token-factory-invalid'
  | 'work-not-admitted'
  | 'work-holder-mismatch'
  | 'work-commit-closed'
  | 'work-release-closed'
  | 'prepare-in-progress'
  | 'prepare-not-draining'
  | 'active-work'
  | 'not-prepared'
  | 'invalid-release-token'
  | 'stale-release'
  | 'prepare-mismatch'
  | 'release-token-mismatch'
  | 'stale-prepare'
  | 'prepare-token-mismatch'
  | 'hibernation-token-mismatch'
  | 'unknown-required-extension'
  | 'roster-mismatch'
  | 'roster-drift'
  | 'clock-invalid'
  | 'deadline-expired'
  | 'invalid-prepare-request'
  | 'invalid-required-extensions'
  | 'required-extension-count-limit'
  | 'invalid-deadline'
  | 'invalid-required-extension-id'
  | 'duplicate-required-extension-id'
export type LeaseFailure = { ok: false; reason: LeaseFailureReason; activeWorkCount?: number }
export type LeaseSuccess<T extends object = object> = { ok: true } & T
export type LeaseResult<T extends object = object> = LeaseSuccess<T> | LeaseFailure

export type RuntimeGenerationInput = { runtimeId: string }
export type OwnerRegistrationInput = RuntimeGenerationInput & {
  extensionId: string
  ownerId: string
}
export type WorkAdmissionInput = RuntimeGenerationInput & {
  ownerId: string
  workId: string
}
export type WorkHolderInput = WorkAdmissionInput & {
  workToken: string
}
export type PrepareFields = RuntimeGenerationInput & {
  requestId: string
  inventoryHash: string
  requiredExtensionIds: readonly string[]
  deadlineAt: number
}
export type CompletePrepareInput = PrepareFields & { prepareToken: string }
export type CommitInput = PrepareFields & { hibernationToken: string }
export type ReleaseInput = PrepareFields & { token: string }

export type LeaseCoordinatorSnapshot = Readonly<{
  runtimeId: string
  state: LeaseCoordinatorState
  registeredExtensionCount: number
  activeWorkCount: number
  prepare: Readonly<{
    requestId: string
    inventoryHash: string
    requiredExtensionIds: readonly string[]
    deadlineAt: number
  }> | null
}>

export type LeaseCoordinatorOptions = {
  runtimeId: string
  now?: () => number
  tokenFactory: (kind: LeaseTokenKind) => string
}

export class RuntimeLeaseCoordinator {
  constructor(options: LeaseCoordinatorOptions)
  getSnapshot(): LeaseCoordinatorSnapshot
  registerOwner(input: OwnerRegistrationInput): LeaseResult<{ duplicate: boolean }>
  admitWork(input: WorkAdmissionInput): LeaseResult<{ duplicate: boolean; workToken: string }>
  checkWorkCommit(input: WorkHolderInput): LeaseResult
  releaseWork(input: WorkHolderInput): LeaseResult<{ remainingWorkCount: number }>
  beginPrepare(input: PrepareFields): LeaseResult<{
    duplicate: boolean
    prepareToken: string
    activeWorkCount: number
  }>
  completePrepare(input: CompletePrepareInput): LeaseResult<{
    duplicate: boolean
    hibernationToken: string
  }>
  commit(input: CommitInput): LeaseResult<{ duplicate: boolean }>
  release(input: ReleaseInput): LeaseResult<{ duplicate: boolean }>
}

export function createLeaseCoordinator(options: LeaseCoordinatorOptions): RuntimeLeaseCoordinator
