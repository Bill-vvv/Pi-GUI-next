import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  GitDiffRequest,
  GitDiffResult,
  GitFileMutationRequest,
  GitMutationResult,
  GitRefreshResult,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import {
  GitCapabilityController,
  type GitCapabilityService,
  type GitCapabilityServiceFactory
} from './git-capability-controller.ts'

const REPOSITORY = '/tmp/pi-gui-repository'
const PROJECT = `${REPOSITORY}/project`
const OTHER_PROJECT = `${REPOSITORY}/other-project`
const RENDERER_KEY = '/tmp/pi-gui-renderer-key'
const NEW_REPOSITORY = '/tmp'
const HASH = 'a'.repeat(64)
const OID = 'b'.repeat(40)

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for deterministic controller test condition.')
}

function state(
  projectRoot: string,
  kind: GitRepositoryState['kind'] = 'repository',
  repositoryRoot: string | null = kind === 'not-repository' ? null : projectRoot,
  statusRevision = HASH
): GitRepositoryState {
  return {
    kind,
    projectRoot,
    repositoryRoot,
    headOid: kind === 'repository' ? OID : null,
    branch: kind === 'repository' ? 'main' : null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    indexTreeOid: kind === 'repository' ? HASH : null,
    indexFingerprint: HASH,
    worktreeFingerprint: HASH,
    statusRevision,
    files: [],
    truncated: false,
    refreshedAt: 1,
    lastError: kind === 'trust-required'
      ? { code: 'trust-required', message: 'trust', stderrCharacters: 0 }
      : null
  }
}

function service(options: {
  refresh: () => GitRefreshResult | Promise<GitRefreshResult>
  getDiff?: (request: GitDiffRequest) => GitDiffResult | Promise<GitDiffResult>
  mutateFile?: (request: GitFileMutationRequest) => GitMutationResult | Promise<GitMutationResult>
}): GitCapabilityService {
  return {
    refreshSafe: async () => await options.refresh(),
    getDiff: async (request) => options.getDiff === undefined
      ? diffResult(request)
      : await options.getDiff(request),
    mutateFile: async (request) => options.mutateFile === undefined
      ? { ok: false, action: request.action, path: request.path, error: error('git-error'), state: null }
      : await options.mutateFile(request)
  }
}

function diffRequest(): GitDiffRequest {
  return {
    kind: 'working',
    path: 'src/file.ts',
    expectedRepositoryRoot: PROJECT,
    expectedHeadOid: OID,
    expectedIndexTreeOid: HASH,
    expectedStatusRevision: HASH
  }
}

function mutationRequest(action: 'stage' | 'unstage' = 'stage'): GitFileMutationRequest {
  return {
    action,
    path: 'src/file.ts',
    expectedRepositoryRoot: PROJECT,
    expectedHeadOid: OID,
    expectedIndexTreeOid: HASH,
    expectedIndexFingerprint: HASH,
    expectedFileFingerprint: HASH,
    expectedWorktreeFingerprint: HASH,
    expectedStatusRevision: HASH
  }
}

function diffResult(request: GitDiffRequest): GitDiffResult {
  return {
    kind: request.kind,
    path: request.path,
    state: 'ready',
    revision: HASH,
    headOid: OID,
    indexTreeOid: HASH,
    worktreeFingerprint: HASH,
    files: [],
    byteCount: 0,
    fileCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error: null
  }
}

function error(code: 'git-error' | 'trust-required' | 'stale') {
  return { code, message: code, stderrCharacters: 0 } as const
}

test('never passes an arbitrary Renderer project key as cwd and tags the response', async () => {
  const createdFor: string[] = []
  const controller = new GitCapabilityController(
    async (projectKey) => {
      assert.equal(projectKey, RENDERER_KEY)
      return PROJECT
    },
    (projectPath) => {
      createdFor.push(projectPath)
      return service({ refresh: () => ({ ok: true, state: state(PROJECT) }) })
    }
  )

  const response = await controller.dispatch({ type: 'git.refresh', projectKey: RENDERER_KEY })
  assert.equal(response.projectKey, RENDERER_KEY)
  assert.deepEqual(createdFor, [PROJECT])
})

test('resolver failures reject before any Git service is created', async () => {
  let factoryCalls = 0
  const controller = new GitCapabilityController(
    async () => { throw new Error('task or mismatch') },
    () => {
      factoryCalls += 1
      return service({ refresh: () => ({ ok: true, state: state(PROJECT) }) })
    }
  )

  const response = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.equal(factoryCalls, 0)
  assert.equal(response.projectKey, PROJECT)
  assert.equal('ok' in response.result && response.result.ok, false)
  if ('ok' in response.result && !response.result.ok) {
    assert.deepEqual(response.result.error, {
      code: 'git-error',
      message: 'Active Project is unavailable for Git.',
      stderrCharacters: 0
    })
  }
})

test('returns bounded typed refresh failures instead of throwing', async () => {
  const failure = { ok: false, error: { code: 'timeout', message: 'Git operation timed out.', stderrCharacters: 19 } } as const
  const controller = new GitCapabilityController(
    async () => PROJECT,
    () => service({ refresh: () => failure })
  )
  assert.deepEqual(
    await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT }),
    { projectKey: PROJECT, result: failure }
  )
})

test('stores an exact fresh ancestor grant and rejects wrong or stale echoes without storing', async () => {
  const trust = state(PROJECT, 'trust-required', REPOSITORY, HASH)
  const repository = state(PROJECT, 'repository', REPOSITORY, 'c'.repeat(64))
  const authorizations: Array<string | undefined> = []
  const factory: GitCapabilityServiceFactory = (_projectPath, options) => {
    authorizations.push(options?.authorizedRepositoryRoot)
    return service({
      refresh: () => ({
        ok: true,
        state: options?.authorizedRepositoryRoot === REPOSITORY ? repository : trust
      })
    })
  }
  const controller = new GitCapabilityController(async () => PROJECT, factory)

  const challenge = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.equal('ok' in challenge.result && challenge.result.ok && challenge.result.state.kind, 'trust-required')

  const wrong = await controller.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: '/tmp/wrong-repository',
    expectedStatusRevision: HASH
  })
  assert.equal('ok' in wrong.result && wrong.result.ok, false)
  assert.deepEqual(authorizations, [undefined])

  const stale = await controller.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: 'd'.repeat(64)
  })
  assert.equal('ok' in stale.result && stale.result.ok, false)
  assert.deepEqual(authorizations, [undefined])

  const granted = await controller.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH
  })
  assert.equal('ok' in granted.result && granted.result.ok && granted.result.state.kind, 'repository')
  assert.deepEqual(authorizations, [undefined, undefined, REPOSITORY])
})

test('keeps grants per Project and only in controller process memory', async () => {
  const authorized = new Set<string>()
  const makeFactory = (): GitCapabilityServiceFactory => (projectPath, options) => service({
    refresh: () => {
      if (options?.authorizedRepositoryRoot === REPOSITORY) authorized.add(projectPath)
      return {
        ok: true,
        state: options?.authorizedRepositoryRoot === REPOSITORY
          ? state(projectPath, 'repository', REPOSITORY)
          : state(projectPath, 'trust-required', REPOSITORY)
      }
    }
  })
  const resolver = async (projectKey: string) => projectKey
  const first = new GitCapabilityController(resolver, makeFactory())
  await first.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  await first.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH
  })
  const other = await first.dispatch({ type: 'git.refresh', projectKey: OTHER_PROJECT })
  assert.equal('ok' in other.result && other.result.ok && other.result.state.kind, 'trust-required')
  assert.deepEqual([...authorized], [PROJECT])

  const restarted = new GitCapabilityController(resolver, makeFactory())
  const afterRestart = await restarted.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.equal('ok' in afterRestart.result && afterRestart.result.ok && afterRestart.result.state.kind, 'trust-required')
})

test('repository root changes revoke the old grant and fail closed with a fresh challenge', async () => {
  let authorizedRefreshes = 0
  const authorizationRoots: Array<string | undefined> = []
  const factory: GitCapabilityServiceFactory = (_projectPath, options) => {
    authorizationRoots.push(options?.authorizedRepositoryRoot)
    if (options?.authorizedRepositoryRoot === REPOSITORY) {
      return service({
        refresh: () => {
          authorizedRefreshes += 1
          return {
            ok: true,
            state: authorizedRefreshes === 1
              ? state(PROJECT, 'repository', REPOSITORY)
              : state(PROJECT, 'trust-required', NEW_REPOSITORY, 'e'.repeat(64))
          }
        }
      })
    }
    const defaultRoot = authorizationRoots.length >= 4 ? NEW_REPOSITORY : REPOSITORY
    const revision = defaultRoot === NEW_REPOSITORY ? 'e'.repeat(64) : HASH
    return service({ refresh: () => ({ ok: true, state: state(PROJECT, 'trust-required', defaultRoot, revision) }) })
  }
  const controller = new GitCapabilityController(async () => PROJECT, factory)
  await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  await controller.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH
  })

  const changed = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.equal('ok' in changed.result && changed.result.ok && changed.result.state.kind, 'trust-required')
  if ('ok' in changed.result && changed.result.ok) {
    assert.equal(changed.result.state.repositoryRoot, NEW_REPOSITORY)
  }
  assert.equal(authorizationRoots.includes(NEW_REPOSITORY), false)
})

test('project-tags diff and mutation results and forwards validated inputs unchanged', async () => {
  const expectedDiff = diffRequest()
  const expectedMutation = mutationRequest('unstage')
  let receivedDiff: GitDiffRequest | null = null
  let receivedMutation: GitFileMutationRequest | null = null
  const mutationResult: GitMutationResult = {
    ok: false,
    action: 'unstage',
    path: expectedMutation.path,
    error: error('stale'),
    state: state(PROJECT)
  }
  const controller = new GitCapabilityController(
    async () => PROJECT,
    () => service({
      refresh: () => ({ ok: true, state: state(PROJECT) }),
      getDiff: (request) => {
        receivedDiff = request
        return diffResult(request)
      },
      mutateFile: (request) => {
        receivedMutation = request
        return mutationResult
      }
    })
  )

  const diff = await controller.dispatch({ type: 'git.get-diff', projectKey: PROJECT, request: expectedDiff })
  const mutation = await controller.dispatch({ type: 'git.mutate-file', projectKey: PROJECT, request: expectedMutation })
  assert.equal(diff.projectKey, PROJECT)
  assert.equal(mutation.projectKey, PROJECT)
  assert.equal(receivedDiff, expectedDiff)
  assert.equal(receivedMutation, expectedMutation)
  assert.deepEqual(mutation.result, mutationResult)
})

test('enforces state kind and canonical repository-root identity', async () => {
  const invalidStates = [
    state(PROJECT, 'not-repository', REPOSITORY),
    state(PROJECT, 'trust-required', null),
    state(PROJECT, 'trust-required', PROJECT),
    state(PROJECT, 'trust-required', '/tmp/pi-gui-sibling-repository'),
    state(PROJECT, 'repository', REPOSITORY),
    state(PROJECT, 'repository', null)
  ]

  for (const invalidState of invalidStates) {
    const controller = new GitCapabilityController(
      async () => PROJECT,
      () => service({ refresh: () => ({ ok: true, state: invalidState }) })
    )
    const response = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
    assert.equal('ok' in response.result && response.result.ok, false, `${invalidState.kind}:${invalidState.repositoryRoot}`)
    if ('ok' in response.result && !response.result.ok) {
      assert.deepEqual(response.result.error, {
        code: 'git-error',
        message: 'Git service returned an invalid Project identity.',
        stderrCharacters: 0
      })
    }
  }
})

test('serializes a diff preflight and use before a concurrent failing refresh', async () => {
  const preflight = deferred<GitRefreshResult>()
  let refreshCalls = 0
  let diffCalls = 0
  const sharedService = service({
    refresh: () => {
      refreshCalls += 1
      if (refreshCalls === 1) return { ok: true, state: state(PROJECT) }
      if (refreshCalls === 2) return preflight.promise
      return { ok: false, error: { code: 'timeout', message: 'Git operation timed out.', stderrCharacters: 7 } }
    },
    getDiff: (request) => {
      diffCalls += 1
      return diffResult(request)
    }
  })
  const controller = new GitCapabilityController(async () => PROJECT, () => sharedService)
  await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })

  const pendingDiff = controller.dispatch({ type: 'git.get-diff', projectKey: PROJECT, request: diffRequest() })
  await waitFor(() => refreshCalls === 2)
  const pendingRefresh = controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(refreshCalls, 2)
  assert.equal(diffCalls, 0)

  preflight.resolve({ ok: true, state: state(PROJECT) })
  const diff = await pendingDiff
  const refresh = await pendingRefresh
  assert.equal(diff.projectKey, PROJECT)
  assert.equal('state' in diff.result && diff.result.state, 'ready')
  assert.equal(diffCalls, 1)
  assert.equal('ok' in refresh.result && refresh.result.ok, false)
})

test('serializes mutation preflight and use before root-changing or failing refreshes', async () => {
  const scenarios: GitRefreshResult[] = [
    { ok: true, state: state(PROJECT, 'trust-required', REPOSITORY, 'c'.repeat(64)) },
    { ok: false, error: { code: 'git-error', message: 'Git operation failed.', stderrCharacters: 11 } }
  ]

  for (const refreshResult of scenarios) {
    const preflight = deferred<GitRefreshResult>()
    let refreshCalls = 0
    let mutationCalls = 0
    const sharedService = service({
      refresh: () => {
        refreshCalls += 1
        if (refreshCalls === 1) return { ok: true, state: state(PROJECT) }
        if (refreshCalls === 2) return preflight.promise
        return refreshResult
      },
      mutateFile: (request) => {
        mutationCalls += 1
        return { ok: true, action: request.action, path: request.path, state: state(PROJECT) }
      }
    })
    const controller = new GitCapabilityController(async () => PROJECT, () => sharedService)
    await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })

    const pendingMutation = controller.dispatch({
      type: 'git.mutate-file',
      projectKey: PROJECT,
      request: mutationRequest()
    })
    await waitFor(() => refreshCalls === 2)
    const pendingRefresh = controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(refreshCalls, 2)
    assert.equal(mutationCalls, 0)

    preflight.resolve({ ok: true, state: state(PROJECT) })
    const mutation = await pendingMutation
    const refresh = await pendingRefresh
    assert.equal('ok' in mutation.result && mutation.result.ok, true)
    assert.equal(mutationCalls, 1)
    if (refreshResult.ok) {
      assert.equal('ok' in refresh.result && refresh.result.ok && refresh.result.state.kind, 'trust-required')
    } else {
      assert.equal('ok' in refresh.result && refresh.result.ok, false)
    }
  }
})

test('a newer challenge wins when an older authorization resolves its active Project later', async () => {
  let heldResolution: Deferred<string> | null = null
  let currentRoot = REPOSITORY
  let currentRevision = HASH
  const authorizedRoots: string[] = []
  const resolver = async (): Promise<string> => {
    const held = heldResolution
    heldResolution = null
    return held === null ? PROJECT : await held.promise
  }
  const factory: GitCapabilityServiceFactory = (_projectPath, options) => {
    if (options?.authorizedRepositoryRoot !== undefined) {
      authorizedRoots.push(options.authorizedRepositoryRoot)
      return service({
        refresh: () => ({
          ok: true,
          state: state(PROJECT, 'repository', options.authorizedRepositoryRoot, 'd'.repeat(64))
        })
      })
    }
    return service({
      refresh: () => ({
        ok: true,
        state: state(PROJECT, 'trust-required', currentRoot, currentRevision)
      })
    })
  }
  const controller = new GitCapabilityController(resolver, factory)
  await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })

  heldResolution = deferred<string>()
  const oldResolution = heldResolution
  const oldAuthorization = controller.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH
  })
  currentRoot = NEW_REPOSITORY
  currentRevision = 'c'.repeat(64)
  const newerChallenge = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.equal('ok' in newerChallenge.result && newerChallenge.result.ok && newerChallenge.result.state.repositoryRoot, NEW_REPOSITORY)

  oldResolution.resolve(PROJECT)
  const stale = await oldAuthorization
  assert.equal('ok' in stale.result && stale.result.ok, false)
  assert.deepEqual(authorizedRoots, [])

  const granted = await controller.dispatch({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: NEW_REPOSITORY,
    expectedStatusRevision: currentRevision
  })
  assert.equal('ok' in granted.result && granted.result.ok && granted.result.state.repositoryRoot, NEW_REPOSITORY)
  assert.deepEqual(authorizedRoots, [NEW_REPOSITORY])
})

test('keeps different Project queues independent', async () => {
  const projectRefresh = deferred<GitRefreshResult>()
  let projectStarted = false
  const controller = new GitCapabilityController(
    async (projectKey) => projectKey,
    (projectPath) => service({
      refresh: () => {
        if (projectPath === PROJECT) {
          projectStarted = true
          return projectRefresh.promise
        }
        return { ok: true, state: state(OTHER_PROJECT) }
      }
    })
  )

  const pendingProject = controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  await waitFor(() => projectStarted)
  const other = await controller.dispatch({ type: 'git.refresh', projectKey: OTHER_PROJECT })
  assert.equal('ok' in other.result && other.result.ok && other.result.state.projectRoot, OTHER_PROJECT)

  projectRefresh.resolve({ ok: true, state: state(PROJECT) })
  const project = await pendingProject
  assert.equal('ok' in project.result && project.result.ok && project.result.state.projectRoot, PROJECT)
})

test('returns typed failures without poisoning the next Project operation', async () => {
  let refreshCalls = 0
  const controller = new GitCapabilityController(
    async () => PROJECT,
    () => service({
      refresh: () => {
        refreshCalls += 1
        if (refreshCalls === 1) throw new Error('unexpected service rejection')
        return { ok: true, state: state(PROJECT) }
      }
    })
  )

  const failed = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.deepEqual(failed, {
    projectKey: PROJECT,
    result: {
      ok: false,
      error: { code: 'git-error', message: 'Git controller operation failed.', stderrCharacters: 0 }
    }
  })
  const recovered = await controller.dispatch({ type: 'git.refresh', projectKey: PROJECT })
  assert.equal('ok' in recovered.result && recovered.result.ok, true)
})

test('revalidates commands at the controller boundary', async () => {
  const controller = new GitCapabilityController(async () => PROJECT, () => {
    assert.fail('invalid commands must not reach the service factory')
  })
  await assert.rejects(
    controller.dispatch({ type: 'git.refresh', projectKey: PROJECT, cwd: '/tmp/arbitrary' }),
    /Invalid Git command/
  )
})
