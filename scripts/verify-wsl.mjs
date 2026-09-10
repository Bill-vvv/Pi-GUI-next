import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWslBackend, resolveWslFilePath } from '../src/main/remote/wsl-backend.ts'
import { wslBuildFingerprint } from '../src/main/remote/wsl-pipe.ts'
import { KERNEL_COMMAND_CHANNEL, isKernelSnapshot } from '../src/shared/kernel-contract.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distribution = process.argv[2] ?? 'Ubuntu-24.04'
const launcherPath = process.argv[3]
if (!launcherPath) throw new Error('Usage: node scripts/verify-wsl.mjs DISTRO /absolute/start-host.sh')
await mkdir(resolve(root, 'release/evidence'), { recursive: true })
const log = createWriteStream(resolve(root, 'release/evidence/wsl-backend.log'), { flags: 'w' })
let backend
try {
  backend = await startWslBackend({
    distribution, launcherPath,
    fingerprint: wslBuildFingerprint(resolve(root, 'out/main/index.js')),
    onEvent: () => {}, onDiagnostic: (chunk) => log.write(chunk)
  })
  const info = await backend.pipe.ready
  assert.equal(info.platform, 'linux')
  assert.ok(info.home.startsWith('/'))
  const state = await backend.pipe.request(KERNEL_COMMAND_CHANNEL, { type: 'kernel.get-state' })
  assert.ok(isKernelSnapshot(state))
  const fonts = await backend.pipe.request(KERNEL_COMMAND_CHANNEL, { type: 'kernel.list-system-fonts' })
  assert.ok(Array.isArray(fonts) && fonts.length > 0)
  const mapped = await resolveWslFilePath(distribution, root)
  assert.ok(mapped.startsWith('/'))
  console.log(JSON.stringify({ connected: true, distribution, platform: info.platform, home: info.home, revision: state.revision, projects: state.projects.length, fonts: fonts.length, mappedProjectPath: mapped }))
} finally {
  await backend?.close()
  log.end()
}
