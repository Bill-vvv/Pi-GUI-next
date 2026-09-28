import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_IDENTITY_FILE_NAME, readBuildIdentityFile, sourceBuildDigest, verifyBuildArtifacts } from '../src/main/build-identity.ts'

export function workspaceSuffix(command) {
  return ['typecheck', 'test', 'test-platform'].includes(command) ? '-checks' : ''
}

export function canReuseBuild(root) {
  const manifest = join(root, 'out/main', BUILD_IDENTITY_FILE_NAME)
  if (!existsSync(manifest)) return false
  const identity = readBuildIdentityFile(manifest)
  if (identity.sourceDigest !== sourceBuildDigest(root)) return false
  verifyBuildArtifacts(root, identity)
  return true
}
