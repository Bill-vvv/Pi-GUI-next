import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolvePiPackageRootLayout } from './pi-package-root.ts'

test('resolves the Pi package behind a pnpm executable shim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-package-root-pnpm-'))
  t.after(async () => rm(root, { recursive: true, force: true }))

  const packageRoot = join(
    root,
    'node_modules/.pnpm/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent'
  )
  const dist = join(packageRoot, 'dist')
  const bin = join(root, 'node_modules/.bin')
  const executable = join(dist, 'cli.js')
  const sdkEntry = join(dist, 'index.js')
  const shim = join(bin, 'pi')
  await mkdir(dist, { recursive: true })
  await mkdir(bin, { recursive: true })
  if (process.platform === 'win32') {
    const scope = join(root, 'node_modules/@earendil-works')
    await mkdir(scope, { recursive: true })
    await symlink(packageRoot, join(scope, 'pi-coding-agent'), 'junction')
  }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    version: '0.83.0',
    exports: { '.': { import: './dist/index.js' } }
  }))
  await writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o755 })
  await writeFile(sdkEntry, 'export {}\n')
  await writeFile(shim, `#!/bin/sh\n# cmd-shim-target=${executable}\n`, { mode: 0o755 })

  assert.deepEqual(await resolvePiPackageRootLayout({ explicitExecutable: shim }), {
    executablePath: executable,
    packageRoot,
    sdkEntryPath: sdkEntry
  })
})
