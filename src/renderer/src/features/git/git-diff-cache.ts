import type {
  GitDiffKind,
  GitDiffResult,
  GitFileChange,
  GitRepositoryState
} from '../../../../shared/git-contract'

export const GIT_DIFF_CACHE_MAX_ENTRIES = 8
export const GIT_DIFF_CACHE_MAX_WEIGHT = 8 * 1024 * 1024
export const GIT_DIFF_MAX_EXPANDED_FILES = 8

export function gitRepositorySnapshotKey(
  projectKey: string,
  state: GitRepositoryState
): string {
  return [
    projectKey,
    state.repositoryRoot ?? '',
    state.statusRevision,
    state.headOid ?? '',
    state.indexTreeOid ?? '',
    state.worktreeFingerprint
  ].join('\u0000')
}

export function gitDiffCacheKey(
  projectKey: string,
  state: GitRepositoryState,
  file: GitFileChange,
  kind: GitDiffKind
): string {
  return [
    gitRepositorySnapshotKey(projectKey, state),
    file.id,
    file.fingerprint,
    kind
  ].join('\u0000')
}

export function isCacheableGitDiffResult(result: GitDiffResult): boolean {
  return result.state === 'ready' ||
    result.state === 'binary' ||
    result.state === 'oversized' ||
    result.state === 'unsupported'
}

export class GitMutationGate {
  readonly #active = new Set<string>()

  tryAcquire(key: string): boolean {
    if (this.#active.has(key)) return false
    this.#active.add(key)
    return true
  }

  release(key: string): void {
    this.#active.delete(key)
  }
}

export class GitDiffRequestPool<T> {
  readonly #requests = new Map<string, Promise<T>>()

  has(key: string): boolean {
    return this.#requests.has(key)
  }

  getOrCreate(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#requests.get(key)
    if (existing !== undefined) return existing
    let tracked: Promise<T>
    tracked = Promise.resolve().then(load).finally(() => {
      if (this.#requests.get(key) === tracked) this.#requests.delete(key)
    })
    this.#requests.set(key, tracked)
    return tracked
  }

  clear(): void {
    this.#requests.clear()
  }
}

export function setBoundedGitDiffEntry<T>(
  current: ReadonlyMap<string, T>,
  key: string,
  value: T,
  maxEntries = GIT_DIFF_MAX_EXPANDED_FILES
): ReadonlyMap<string, T> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Git diff map maxEntries must be a positive safe integer.')
  }
  const next = new Map(current)
  next.delete(key)
  next.set(key, value)
  while (next.size > maxEntries) {
    const oldestKey = next.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    next.delete(oldestKey)
  }
  return next
}

export class GitDiffLruCache {
  readonly maxEntries: number
  readonly maxWeight: number
  readonly #entries = new Map<string, { result: GitDiffResult; weight: number }>()
  #weight = 0

  constructor(
    maxEntries = GIT_DIFF_CACHE_MAX_ENTRIES,
    maxWeight = GIT_DIFF_CACHE_MAX_WEIGHT
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Git diff cache maxEntries must be a positive safe integer.')
    }
    if (!Number.isSafeInteger(maxWeight) || maxWeight < 1) {
      throw new Error('Git diff cache maxWeight must be a positive safe integer.')
    }
    this.maxEntries = maxEntries
    this.maxWeight = maxWeight
  }

  get size(): number {
    return this.#entries.size
  }

  get weight(): number {
    return this.#weight
  }

  get(key: string): GitDiffResult | null {
    const entry = this.#entries.get(key)
    if (entry === undefined) return null
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: GitDiffResult): void {
    if (!isCacheableGitDiffResult(result)) return
    const weight = estimateGitDiffWeight(result)
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      this.#entries.delete(key)
      this.#weight -= existing.weight
    }
    if (weight > this.maxWeight) return
    this.#entries.set(key, { result, weight })
    this.#weight += weight
    while (this.#entries.size > this.maxEntries || this.#weight > this.maxWeight) {
      const oldestKey = this.#entries.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.#entries.get(oldestKey)
      this.#entries.delete(oldestKey)
      if (oldest !== undefined) this.#weight -= oldest.weight
    }
  }

  clear(): void {
    this.#entries.clear()
    this.#weight = 0
  }
}

function estimateGitDiffWeight(result: GitDiffResult): number {
  const structuralWeight = result.lineCount * 160 + result.hunkCount * 192 + 1_024
  return Math.max(result.byteCount, structuralWeight)
}
