import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import { SUPPORTED_PI_VERSION } from './pi-executable.ts'
import { resolvePiPackageRootLayout } from './pi-package-root.ts'

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-gui-package-root-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  return directory
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function writeWindowsShimFixture(t: TestContext, declaredBin = 'dist/cli.js'): {
  packageRoot: string
  executable: string
  sdkEntryPath: string
} {
  const root = temporaryDirectory(t)
  const packageRoot = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const dist = join(packageRoot, 'dist')
  const bin = join(root, 'bin')
  mkdirSync(dist, { recursive: true })
  mkdirSync(bin)

  const cliPath = join(dist, 'cli.js')
  const sdkEntryPath = join(dist, 'index.js')
  writeFileSync(cliPath, `process.stdout.write('${SUPPORTED_PI_VERSION}\\n')\n`)
  writeFileSync(sdkEntryPath, 'export const marker = true\n')
  writeFileSync(join(dist, 'other.js'), '')
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      version: SUPPORTED_PI_VERSION,
      bin: { pi: declaredBin },
      exports: { '.': { import: './dist/index.js' } }
    })
  )

  const executable = join(bin, 'pi.cmd')
  writeFileSync(executable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`, { mode: 0o755 })
  return { packageRoot, executable, sdkEntryPath }
}

test('a Windows command shim reports and verifies its actual Pi package entry', async (t) => {
  const fixture = writeWindowsShimFixture(t)

  const layout = await resolvePiPackageRootLayout({
    explicitExecutable: fixture.executable,
    platform: 'win32',
    versionTimeoutMs: 1_000
  })

  assert.equal(layout.executablePath, resolve(fixture.executable))
  assert.equal(layout.packageRoot, resolve(fixture.packageRoot))
  assert.equal(layout.sdkEntryPath, resolve(fixture.sdkEntryPath))
})

test('a Windows command shim rejects a package manifest that declares another Pi entry', async (t) => {
  const fixture = writeWindowsShimFixture(t, 'dist/other.js')

  await assert.rejects(
    resolvePiPackageRootLayout({
      explicitExecutable: fixture.executable,
      platform: 'win32',
      versionTimeoutMs: 1_000
    }),
    /does not resolve to the declared Pi package entry/i
  )
})
