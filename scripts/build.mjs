import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceBuildDigest } from '../src/main/build-identity.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const env = { ...process.env, PI_GUI_BUILD_SOURCE_DIGEST: sourceBuildDigest(root) }
for (const [entry, args] of [
  [join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js'), ['build']],
  [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ['build', '--config', 'vite.remote.config.ts']],
  [join(root, 'scripts/write-build-identity.mjs'), []]
]) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
