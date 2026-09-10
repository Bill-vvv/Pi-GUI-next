import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, delimiter } from 'node:path'
import test, { type TestContext } from 'node:test'

import { checkPiVersion, resolvePiExecutable, piLaunch, SUPPORTED_PI_VERSION } from './pi-executable.ts'

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-gui-executable-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  return directory
}

function writeExecutable(directory: string, body = ''): string {
  const executable = process.platform === 'win32'
    ? join(directory, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
    : join(directory, 'pi')
  if (process.platform === 'win32') {
    mkdirSync(join(directory, 'node_modules/@earendil-works/pi-coding-agent/dist'), { recursive: true })
    writeFileSync(join(directory, 'pi.cmd'), '@echo off\n')
  }
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

  assert.equal(resolvePiExecutable({ path: `${firstDirectory}${delimiter}${secondDirectory}` }), resolve(first))
})

test('the user-local Pi install is found when Electron PATH omits it', (t) => {
  const root = temporaryDirectory(t)
  const directory = join(root, '.local/bin')
  mkdirSync(directory, { recursive: true })
  const executable = writeExecutable(directory)
  if (process.platform === 'win32') writeFileSync(join(directory, 'pi'), '#!/bin/sh\n')

  assert.equal(resolvePiExecutable({ path: '', homeDir: root }), resolve(executable))
})

test('missing Pi asks for an explicit path', (t) => {
  const directory = temporaryDirectory(t)

  assert.throws(() => resolvePiExecutable({ path: directory, homeDir: directory }), /not found.*Provide the path/i)
})

test('an explicit non-executable file fails immediately', { skip: process.platform === 'win32' }, (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory)
  chmodSync(executable, 0o644)

  assert.throws(() => resolvePiExecutable({ explicitPath: executable, path: '' }), /not executable.*Grant execute permission/i)
})

test('Windows npm shims resolve to a Node entry without evaluating shell text', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = temporaryDirectory(t)
  const entry = writeExecutable(directory, `process.stdout.write('${SUPPORTED_PI_VERSION}')`)
  const shim = join(directory, 'pi.cmd')
  assert.equal(resolvePiExecutable({ explicitPath: shim }), entry)
  await checkPiVersion({ executable: entry, cwd: directory })
  const args = ['space in argument', '& echo injected', '%PATH%']
  const launch = piLaunch(entry, args, { CUSTOM: 'preserved' })
  assert.equal(launch.command, process.execPath)
  assert.deepEqual(launch.args, [entry, ...args])
  assert.equal(launch.env.CUSTOM, 'preserved')
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
})

test('the exact supported version passes', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory, `process.stdout.write('${SUPPORTED_PI_VERSION}\\n')`)

  await assert.doesNotReject(checkPiVersion({ executable, cwd: directory }))
})

test('a different Pi version fails', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = writeExecutable(directory, "process.stdout.write('0.82.9\\n')")

  await assert.rejects(checkPiVersion({ executable, cwd: directory }), /Unsupported Pi version.*0\.83\.0/)
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
