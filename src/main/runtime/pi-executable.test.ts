import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import { checkPiVersion, resolvePiExecutable, SUPPORTED_PI_VERSION } from './pi-executable.ts'

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-gui-executable-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  return directory
}

function writeExecutable(directory: string, body = ''): string {
  const executable = join(directory, 'pi')
  writeFileSync(executable, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 })
  return executable
}

test('an explicit executable takes priority over PATH', (t) => {
  const root = temporaryDirectory(t)
  const explicitDirectory = join(root, 'explicit')
  const pathDirectory = join(root, 'path')
  mkdirSync(explicitDirectory)
  mkdirSync(pathDirectory)
  const explicit = writeExecutable(explicitDirectory)
  writeExecutable(pathDirectory)

  assert.equal(resolvePiExecutable({ explicitPath: explicit, path: pathDirectory }), resolve(explicit))
})

test('PATH directories are checked in order', (t) => {
  const root = temporaryDirectory(t)
  const firstDirectory = join(root, 'first')
  const secondDirectory = join(root, 'second')
  mkdirSync(firstDirectory)
  mkdirSync(secondDirectory)
  const first = writeExecutable(firstDirectory)
  writeExecutable(secondDirectory)

  assert.equal(resolvePiExecutable({ path: `${firstDirectory}:${secondDirectory}` }), resolve(first))
})

test('missing Pi asks for an explicit path', (t) => {
  const directory = temporaryDirectory(t)

  assert.throws(() => resolvePiExecutable({ path: directory }), /not found.*Provide the path/i)
})

test('an explicit non-executable file fails immediately', (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory)
  chmodSync(executable, 0o644)

  assert.throws(() => resolvePiExecutable({ explicitPath: executable, path: '' }), /not executable.*Grant execute permission/i)
})

test('the exact supported version passes', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory, `process.stdout.write('${SUPPORTED_PI_VERSION}\\n')`)

  await assert.doesNotReject(checkPiVersion({ executable, cwd: directory }))
})

test('a different Pi version fails', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory, "process.stdout.write('0.80.9\\n')")

  await assert.rejects(checkPiVersion({ executable, cwd: directory }), /Unsupported Pi version.*0\.80\.10/)
})

test('a non-zero version command reports stderr without logging its contents', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory, "process.stderr.write('version failed\\n'); process.exit(7)")

  await assert.rejects(checkPiVersion({ executable, cwd: directory }), /exit code 7.*stderr captured 15 bytes/)
})

test('a hung version command times out', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory, 'setInterval(() => {}, 1_000)')

  await assert.rejects(checkPiVersion({ executable, cwd: directory, timeoutMs: 50 }), /timed out after 50 ms/)
})
