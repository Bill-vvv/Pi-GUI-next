import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import test, { type TestContext } from 'node:test'
import { createBuildIdentity, sourceBuildDigest, parseBuildIdentity, readBuildIdentityFile, resolveBuildCommit, verifyBuildArtifacts } from './build-identity.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-gui-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value) }
  write('scripts/build.mjs', 'build\n')
  for (const path of ['src/main.ts', 'extensions/owned/index.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'vite.remote.config.ts', 'out/main/index.js', 'out/main/worker.js', 'out/preload/index.cjs', 'out/renderer/index.html']) write(path, 'first\n')
  write('package.json', JSON.stringify({ build: { extraResources: [{ from: 'extensions/owned' }] } }))
  const manifest = () => createBuildIdentity(root, 'a'.repeat(40))
  return { root, write, manifest }
}

test('same commit with different source cannot share a build identity; CRLF checkouts can', (t) => {
  const { root, write } = fixture(t)
  const first = sourceBuildDigest(root)
  write('src/main.ts', 'first\r\n')
  assert.equal(sourceBuildDigest(root), first)
  write('src/main.ts', 'uncommitted edit\n')
  assert.notEqual(sourceBuildDigest(root), first)
  assert.throws(() => createBuildIdentity(root, 'a'.repeat(40), first), /changed during the build/)
})

test('manifest checks worker, extension, preload and renderer content, not just Main', (t) => {
  const { root, write, manifest } = fixture(t)
  const identity = manifest()
  verifyBuildArtifacts(root, identity)
  for (const path of ['out/main/worker.js', 'extensions/owned/index.ts', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    write(path, 'changed\n')
    assert.throws(() => verifyBuildArtifacts(root, identity), /Build artifact changed/)
    write(path, 'first\n')
  }
})

test('runtime identity comes from verified source digest and rejects legacy or corrupt manifests', (t) => {
  const { root, write, manifest } = fixture(t)
  const identity = manifest()
  const identityFilePath = join(root, 'out/main/build-identity.json')
  assert.equal(readBuildIdentityFile(identityFilePath), null)
  write('out/main/build-identity.json', JSON.stringify(identity))
  assert.equal(resolveBuildCommit({ identityFilePath }), identity.sourceDigest)
  assert.throws(() => parseBuildIdentity({ commit: 'legacy-head' }), /Invalid build manifest/)
  assert.throws(() => parseBuildIdentity({ ...identity, artifactDigest: 'b'.repeat(64) }), /digest mismatch/)
  assert.throws(() => parseBuildIdentity({ ...identity, files: { ...identity.files, 'out/../../outside': 'a'.repeat(64) } }), /Invalid build manifest file/)
})
