import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPiRpcArguments, LinuxLocalRuntime } from './linux-local-runtime.ts'

test('trusted runtime explicitly enables approval', () => {
  const arguments_ = buildPiRpcArguments('trusted')

  assert.equal(arguments_.filter((argument) => argument === '--approve').length, 1)
  assert.equal(arguments_.includes('--no-approve'), false)
})

test('untrusted runtime explicitly disables approval', () => {
  const arguments_ = buildPiRpcArguments('untrusted')

  assert.equal(arguments_.filter((argument) => argument === '--no-approve').length, 1)
  assert.equal(arguments_.includes('--approve'), false)
})

test('stop during the version check cancels start before spawning RPC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stop-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const rpcMarker = join(directory, 'rpc-started')
  await writeFile(
    executable,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  sleep 0.1\n  printf "0.80.10\\n"\n  exit 0\nfi\nprintf "started" > rpc-started\n',
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    trust: 'untrusted',
    explicitExecutable: executable,
    versionTimeoutMs: 1_000
  })

  const startPromise = runtime.start()
  const stopPromise = runtime.stop()

  await assert.rejects(startPromise, /cancelled/i)
  await stopPromise
  await assert.rejects(access(rpcMarker))
})
