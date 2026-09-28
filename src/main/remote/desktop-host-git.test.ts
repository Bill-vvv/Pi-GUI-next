import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../shared/desktop-host-contract.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { GitCapabilityController } from '../git/git-capability-controller.ts'
import { createActiveRegisteredGitProjectResolver } from '../git/git-active-project-resolver.ts'
import { ProjectStore } from '../project/project-store.ts'
import { DesktopHostClient } from './desktop-host-client.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'
import { openRemoteDeviceStore } from './remote-device-store.ts'
import { DESKTOP_HOST_GIT_COMMAND_TYPES, DESKTOP_HOST_JSON_RESPONSE_BYTE_LIMIT, type DesktopHostCommand, type DesktopHostGitCommand } from '../../shared/desktop-host-contract.ts'
import type { GitDiffRequest, GitDiffResponse, GitFileReadResponse, GitRefreshResponse, GitRepositoryState, GitHistoryListResponse, GitHistoryDetailResponse, GitHistoryFileDiffResponse } from '../../shared/git-contract.ts'
import type { GitFileMutationRequest, GitMutationResponse, GitCommitPreviewResponse, GitCommitExecutionResponse } from '../../shared/git-contract.ts'

const exec = promisify(execFile)
const git = async (cwd: string, args: string[]) => (await exec('git', args, {
  cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
})).stdout

async function fixture(t: TestContext, nestedProject = false) {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-git-'))
  const repository = join(root, '中文 项目')
  const project = nestedProject ? join(repository, 'nested') : repository
  await mkdir(project, { recursive: true })
  await git(repository, ['init', '--initial-branch=main'])
  await git(repository, ['config', 'user.name', 'Fixture'])
  await git(repository, ['config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(repository, '中文 file.txt'), 'before\n')
  await git(repository, ['add', '.'])
  await git(repository, ['commit', '-m', 'initial'])
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  await store.addProject({ path: project })
  let activeProject = project
  let activeSession = 'session-A'
  const kernel = { getState: () => ({ navigatorKind: 'project' as const, activeProjectKey: activeProject, projects: [{ path: project }] }) }
  const controller = new GitCapabilityController(createActiveRegisteredGitProjectResolver(kernel, store))
  const reserve = createServer()
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()))
  let intercept: ((command: DesktopHostGitCommand, boundary: () => Promise<void>) => Promise<unknown>) | null = null
  const gateway = await startDesktopHostGateway({
    config: { enabled: true, bindHost: '127.0.0.1', port, token: 't'.repeat(32), tokenFile: join(root, 'token'), deviceStorePath: join(root, 'device') },
    productVersion: '1.0.0', buildCommit: 'fixture',
    deviceStore: await openRemoteDeviceStore({ path: join(root, 'device'), uid: process.getuid!() }),
    randomPairingCode: () => '123456', randomDeviceCredential: () => 'c'.repeat(43),
    handlers: {
      getControlIdentity: () => ({ projectKey: activeProject, sessionKey: activeSession }),
      assertCommandPolicy: async () => {},
      dispatchCommand: async () => { throw new Error('Kernel commands are not used in this fixture') },
      dispatchGitCommand: (command, boundary) => intercept ? intercept(command, boundary) : controller.dispatch(command, undefined, boundary)
    }
  })
  const client = new DesktopHostClient({ localPort: port, compatibility: { productVersion: '1.0.0', buildCommit: 'fixture' } })
  const status = await client.verifyCompatibility()
  assert.deepEqual(status.capabilities.gitCommandTypes, DESKTOP_HOST_GIT_COMMAND_TYPES)
  gateway.createPairingCode()
  const pairing = await client.pair('123456')
  const controllerId = '11111111-1111-4111-8111-111111111111'
  const stream = await client.openEventStream(controllerId, () => {})
  // Revocation intentionally closes this stream; observe its terminal result immediately.
  const streamClosed = stream.closed.then(() => null, (error: unknown) => error)
  t.after(async () => { await stream.close(); await gateway.stop(); await rm(root, { recursive: true, force: true }) })
  const identity = { projectKey: project, sessionKey: activeSession }
  const command = (value: DesktopHostCommand) => client.command(controllerId, identity, value)
  const refresh = async () => {
    const response = await command({ type: 'git.refresh', projectKey: project }) as GitRefreshResponse
    assert.ok(response.result.ok)
    return response.result.state
  }
  const rawCommand = (value: unknown) => fetch(`http://127.0.0.1:${port}/api/desktop-host/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.credential}`, 'X-Pi-Gui-Controller-Id': controllerId },
    body: JSON.stringify({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, requestId: '22222222-2222-4222-8222-222222222222', expectedIdentity: identity, command: value })
  })
  return { root, project, repository, controller, gateway, command, refresh, rawCommand, streamClosed,
    navigate: (path: string, session: string) => { activeProject = path; activeSession = session },
    intercept: (handler: NonNullable<typeof intercept>) => { intercept = handler } }
}

function diffRequest(state: GitRepositoryState, path: string): GitDiffRequest {
  return { kind: 'working', path, expectedRepositoryRoot: state.repositoryRoot!, expectedHeadOid: state.headOid,
    expectedIndexTreeOid: state.indexTreeOid, expectedStatusRevision: state.statusRevision }
}

function fileRequest(state: GitRepositoryState, path: string) {
  const { kind: _kind, ...request } = diffRequest(state, path)
  return request
}

function mutationRequest(state: GitRepositoryState, path: string, action: 'stage' | 'unstage'): GitFileMutationRequest {
  const file = state.files.find((entry) => entry.path === path)
  assert.ok(file)
  return { ...fileRequest(state, path), action, expectedIndexFingerprint: state.indexFingerprint,
    expectedWorktreeFingerprint: state.worktreeFingerprint, expectedFileFingerprint: file.fingerprint }
}

test('Desktop stages, unstages and commits only the confirmed index over HTTP without replay or push', { timeout: 20_000 }, async (t) => {
  const host = await fixture(t)
  const path = '中文 file.txt'
  await writeFile(join(host.project, path), 'staged version\n')
  let state = await host.refresh()
  const stage = mutationRequest(state, path, 'stage')
  const staged = await host.command({ type: 'git.mutate-file', projectKey: host.project, request: stage }) as GitMutationResponse
  assert.ok(staged.result.ok)
  assert.equal(await git(host.project, ['show', `:${path}`]), 'staged version\n')
  const repeated = await host.command({ type: 'git.mutate-file', projectKey: host.project, request: stage }) as GitMutationResponse
  assert.equal(repeated.result.ok, false)
  if (!repeated.result.ok) assert.equal(repeated.result.error.code, 'stale')
  state = await host.refresh()
  const unstaged = await host.command({ type: 'git.mutate-file', projectKey: host.project, request: mutationRequest(state, path, 'unstage') }) as GitMutationResponse
  assert.ok(unstaged.result.ok)
  assert.equal(await git(host.project, ['show', `:${path}`]), 'before\n')
  assert.equal(await readFile(join(host.project, path), 'utf8'), 'staged version\n')
  state = await host.refresh()
  const restaged = await host.command({ type: 'git.mutate-file', projectKey: host.project, request: mutationRequest(state, path, 'stage') }) as GitMutationResponse
  assert.ok(restaged.result.ok)
  await writeFile(join(host.project, path), 'unstaged version\n')
  const prepared = await host.command({ type: 'git.prepare-commit', projectKey: host.project }) as GitCommitPreviewResponse
  assert.ok(prepared.result.ok)
  const request = { mode: 'commit' as const, message: '用户确认的提交', snapshot: prepared.result.preview.snapshot, expectedPushTarget: prepared.result.preview.pushTarget }
  const before = await git(host.project, ['rev-parse', 'HEAD'])
  for (const mode of ['amend', 'commit-and-push']) {
    const response = await host.rawCommand({ type: 'git.execute-commit', projectKey: host.project,
      request: { ...request, mode, expectedPushTarget: mode === 'commit-and-push' ? { remote: 'origin', branch: 'main' } : null } })
    assert.equal(response.status, 403)
  }
  assert.equal(await git(host.project, ['rev-parse', 'HEAD']), before)
  const results = await Promise.all([0, 1].map(async () => await host.command({ type: 'git.execute-commit', projectKey: host.project, request }) as GitCommitExecutionResponse))
  assert.equal(results.filter((response) => response.result.commit.status === 'succeeded').length, 1)
  assert.equal(results.filter((response) => response.result.commit.status === 'failed').length, 1)
  assert.ok(results.every((response) => response.result.push === null))
  assert.equal((await git(host.project, ['rev-list', '--count', 'HEAD'])).trim(), '2')
  assert.equal(await git(host.project, ['show', `HEAD:${path}`]), 'staged version\n')
  assert.equal(await readFile(join(host.project, path), 'utf8'), 'unstaged version\n')
  assert.equal((await git(host.project, ['log', '-1', '--format=%s'])).trim(), request.message)
  await host.gateway.revokeDevice()
  assert.ok(await host.streamClosed instanceof Error)
  await assert.rejects(host.command({ type: 'git.execute-commit', projectKey: host.project, request }), /Authentication required/)
  assert.equal((await git(host.project, ['rev-list', '--count', 'HEAD'])).trim(), '2')
})

test('Desktop Git rejects conflict staging and commit preparation without changing the index', { timeout: 20_000 }, async (t) => {
  const host = await fixture(t)
  const path = '中文 file.txt'
  await git(host.project, ['checkout', '-b', 'other'])
  await writeFile(join(host.project, path), 'other\n')
  await git(host.project, ['commit', '-am', 'other'])
  await git(host.project, ['checkout', 'main'])
  await writeFile(join(host.project, path), 'main\n')
  await git(host.project, ['commit', '-am', 'main'])
  await assert.rejects(git(host.project, ['merge', 'other']))
  const before = await git(host.project, ['ls-files', '--unmerged'])
  assert.ok(before.length > 0)
  const state = await host.refresh()
  assert.ok(state.files.some((file) => file.conflicted))
  for (const action of ['stage', 'unstage'] as const) {
    const mutation = await host.command({ type: 'git.mutate-file', projectKey: host.project, request: mutationRequest(state, path, action) }) as GitMutationResponse
    assert.equal(mutation.result.ok, false)
    if (!mutation.result.ok) assert.equal(mutation.result.error.code, 'unsupported')
  }
  const preview = await host.command({ type: 'git.prepare-commit', projectKey: host.project }) as GitCommitPreviewResponse
  assert.equal(preview.result.ok, false)
  assert.equal(await git(host.project, ['ls-files', '--unmerged']), before)
})

test('a commit may land before navigation invalidates its response and is never replayed', { timeout: 20_000 }, async (t) => {
  const host = await fixture(t)
  await writeFile(join(host.project, '中文 file.txt'), 'commit before disconnect\n')
  await git(host.project, ['add', '.'])
  const preview = await host.command({ type: 'git.prepare-commit', projectKey: host.project }) as GitCommitPreviewResponse
  assert.ok(preview.result.ok)
  const command = { type: 'git.execute-commit' as const, projectKey: host.project,
    request: { mode: 'commit' as const, message: 'landed once', snapshot: preview.result.preview.snapshot, expectedPushTarget: null } }
  host.intercept(async (value, boundary) => {
    const response = await host.controller.dispatch(value, undefined, boundary)
    if (value.type === 'git.execute-commit') host.navigate(host.project, 'next-session')
    return response
  })
  await assert.rejects(host.command(command), /state changed/)
  assert.equal((await git(host.project, ['rev-list', '--count', 'HEAD'])).trim(), '2')
  await assert.rejects(host.command(command), /state changed/)
  assert.equal((await git(host.project, ['rev-list', '--count', 'HEAD'])).trim(), '2')
})

test('Desktop full file reading returns exact text and rechecks authorization before delivery', { timeout: 15_000 }, async (t) => {
  const host = await fixture(t)
  await writeFile(join(host.project, '中文 file.txt'), 'context\n全文 <script>plain text</script>\n')
  const state = await host.refresh()
  const command = { type: 'git.read-file' as const, projectKey: host.project, request: fileRequest(state, '中文 file.txt') }
  const response = await host.command(command) as GitFileReadResponse
  assert.equal(response.result.state, 'ready')
  assert.equal(response.result.text, 'context\n全文 <script>plain text</script>\n')
  for (const path of ['../private', '/etc/passwd', 'file\0name']) {
    assert.equal((await host.rawCommand({ ...command, request: fileRequest(state, path) })).status, 400)
  }
  assert.equal((await host.rawCommand({ ...command, request: { ...command.request, kind: 'working' } })).status, 400)
  await assert.rejects(host.command({ ...command, projectKey: host.root }), /observed active Project/)
  host.intercept(async (value, boundary) => {
    const result = await host.controller.dispatch(value, undefined, boundary)
    host.navigate(host.project, 'different-session')
    return result
  })
  await assert.rejects(host.command(command), /state changed/)
})

test('Desktop Git reads real Unicode files and bounded diffs without modifying the index', { timeout: 15_000 }, async (t) => {
  const host = await fixture(t)
  const indexBefore = await readFile(join(host.project, '.git/index'))
  await writeFile(join(host.project, '中文 file.txt'), 'after\n')
  let state = await host.refresh()
  const request = diffRequest(state, '中文 file.txt')
  const response = await host.command({ type: 'git.get-diff', projectKey: host.project, request }) as GitDiffResponse
  assert.equal(response.projectKey, host.project)
  assert.equal(response.result.state, 'ready')
  assert.match(JSON.stringify(response.result.files), /after/)
  await writeFile(join(host.project, '中文 file.txt'), 'newer\n')
  const stale = await host.command({ type: 'git.get-diff', projectKey: host.project, request }) as GitDiffResponse
  assert.equal(stale.result.error?.code, 'stale')
  await writeFile(join(host.project, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(host.project, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
  await writeFile(join(host.root, 'private.txt'), 'outside-project-marker')
  await symlink(join(host.root, 'private.txt'), join(host.project, 'outside-link'))
  state = await host.refresh()
  for (const [path, expected] of [['binary.bin', 'binary'], ['large.txt', 'oversized']] as const) {
    const result = await host.command({ type: 'git.get-diff', projectKey: host.project, request: diffRequest(state, path) }) as GitDiffResponse
    assert.equal(result.result.state, expected)
  }
  const linked = await host.command({ type: 'git.get-diff', projectKey: host.project, request: diffRequest(state, 'outside-link') }) as GitDiffResponse
  assert.ok(!JSON.stringify(linked).includes('outside-project-marker'))
  const snapshot = { repositoryRoot: state.repositoryRoot!, headOid: state.headOid, branch: state.branch }
  const history = await host.command({ type: 'git.list-history', projectKey: host.project, request: { snapshot, offset: 0 } }) as GitHistoryListResponse
  assert.ok(history.result.ok)
  assert.equal(history.result.commits.length, 1)
  const oid = history.result.commits[0]!.oid
  const detail = await host.command({ type: 'git.get-history-detail', projectKey: host.project, request: { snapshot, oid } }) as GitHistoryDetailResponse
  assert.ok(detail.result.ok)
  const historical = await host.command({ type: 'git.get-history-file-diff', projectKey: host.project,
    request: { snapshot, oid, fileId: detail.result.files[0]!.fileId } }) as GitHistoryFileDiffResponse
  assert.equal(historical.result.state, 'ready')
  assert.match(JSON.stringify(historical.result.files), /before/)
  assert.deepEqual(await readFile(join(host.project, '.git/index')), indexBefore)
})

test('Desktop Git requires the exact ancestor repository challenge before disclosing its changes', { timeout: 15_000 }, async (t) => {
  const host = await fixture(t, true)
  await writeFile(join(host.repository, '中文 file.txt'), 'ancestor-change\n')
  const challenge = await host.refresh()
  assert.equal(challenge.kind, 'trust-required')
  assert.deepEqual(challenge.files, [])
  const deniedFile = await host.command({ type: 'git.read-file', projectKey: host.project,
    request: fileRequest(challenge, '中文 file.txt') }) as GitFileReadResponse
  assert.equal(deniedFile.result.state, 'trust-required')
  assert.equal(deniedFile.result.text, null)
  const denied = await host.command({ type: 'git.get-diff', projectKey: host.project, request: diffRequest(challenge, '中文 file.txt') }) as GitDiffResponse
  assert.equal(denied.result.state, 'trust-required')
  const stale = await host.command({ type: 'git.authorize-ancestor-repository', projectKey: host.project,
    repositoryRoot: host.root, expectedStatusRevision: challenge.statusRevision }) as GitRefreshResponse
  assert.ok(!stale.result.ok)
  assert.equal(stale.result.error.code, 'stale')
  const granted = await host.command({ type: 'git.authorize-ancestor-repository', projectKey: host.project,
    repositoryRoot: host.repository, expectedStatusRevision: challenge.statusRevision }) as GitRefreshResponse
  assert.ok(granted.result.ok)
  assert.equal(granted.result.state.kind, 'repository')
  const grantedFile = await host.command({ type: 'git.read-file', projectKey: host.project,
    request: fileRequest(granted.result.state, '中文 file.txt') }) as GitFileReadResponse
  assert.equal(grantedFile.result.text, 'ancestor-change\n')
  const diff = await host.command({ type: 'git.get-diff', projectKey: host.project,
    request: diffRequest(granted.result.state, '中文 file.txt') }) as GitDiffResponse
  assert.equal(diff.result.state, 'ready')
  assert.match(JSON.stringify(diff.result.files), /ancestor-change/)
})

test('Desktop Git rejects malformed paths, foreign projects, old sessions and branch commands at HTTP boundary', { timeout: 15_000 }, async (t) => {
  const host = await fixture(t)
  const state = await host.refresh()
  for (const path of ['../private.txt', '/etc/passwd', 'file\0name']) {
    const response = await host.rawCommand({ type: 'git.get-diff', projectKey: host.project, request: diffRequest(state, path) })
    assert.equal(response.status, 400)
  }
  const write = await host.rawCommand({ type: 'git.prepare-branch-sync', projectKey: host.project })
  assert.equal(write.status, 403)
  assert.equal((await host.rawCommand({ type: 'git.refresh', projectKey: 'C:\\project' })).status, 400)
  await assert.rejects(host.command({ type: 'git.refresh', projectKey: host.root }), /observed active Project/)
  host.navigate(host.project, 'session-B')
  await assert.rejects(host.command({ type: 'git.refresh', projectKey: host.project }), /state changed/)
})

test('Desktop Git discards late read results after navigation or device revocation and enforces response budget', { timeout: 15_000 }, async (t) => {
  const host = await fixture(t)
  host.intercept(async () => {
    host.navigate(host.project, 'session-B')
    return { confidential: 'stale-result' }
  })
  await assert.rejects(host.command({ type: 'git.refresh', projectKey: host.project }), /state changed/)
  host.navigate(host.project, 'session-A')
  host.intercept(async () => ({ content: 'x'.repeat(DESKTOP_HOST_JSON_RESPONSE_BYTE_LIMIT) }))
  await assert.rejects(host.command({ type: 'git.refresh', projectKey: host.project }), /response size limit/)
  host.intercept(async () => {
    await host.gateway.revokeDevice()
    return { confidential: 'revoked-result' }
  })
  await assert.rejects(host.command({ type: 'git.refresh', projectKey: host.project }), /Authentication required/)
  assert.ok(await host.streamClosed instanceof Error)
})
