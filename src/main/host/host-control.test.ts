import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'

import {
  HostDataDirectoryInUseError,
  hostControlSocketPath,
  openHostControl,
  requestHostControl,
  type HostControlCommand
} from './host-control.ts'

const linux = { skip: process.platform !== 'linux' }

async function dataDirectory(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-host-control-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'pi-gui-next')
}

test('one Host owns a data directory; a second fails clearly and control reaches the owner', linux, async (t) => {
  const directory = await dataDirectory(t)
  const received: HostControlCommand[] = []
  const control = await openHostControl({
    userDataDirectory: directory,
    dispatch: async (command) => {
      received.push(command)
      if (command.type === 'remote-admin.revoke-desktop-host-device') throw new Error('设备不存在或已撤销。')
      return { enabled: true, endpoint: 'http://127.0.0.1:18788', devices: [] }
    }
  })
  t.after(() => control.close())
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(hostControlSocketPath(directory))).mode & 0o777, 0o600)

  await assert.rejects(openHostControl({ userDataDirectory: directory, dispatch: async () => null }), HostDataDirectoryInUseError)

  assert.deepEqual(await requestHostControl(directory, { type: 'remote-admin.get-desktop-host-status' }),
    { enabled: true, endpoint: 'http://127.0.0.1:18788', devices: [] })
  await assert.rejects(
    requestHostControl(directory, { type: 'remote-admin.revoke-desktop-host-device', deviceId: 'a'.repeat(64) }),
    /设备不存在或已撤销/u
  )
  // Only the Desktop Host device commands are reachable; everything else is refused before dispatch.
  await assert.rejects(
    requestHostControl(directory, { type: 'remote-admin.get-status' } as unknown as HostControlCommand),
    /Unsupported Host control command/u
  )
  assert.deepEqual(received.map(({ type }) => type), [
    'remote-admin.get-desktop-host-status',
    'remote-admin.revoke-desktop-host-device'
  ])

  await control.close()
  await assert.rejects(stat(hostControlSocketPath(directory)), { code: 'ENOENT' })
  await assert.rejects(requestHostControl(directory, { type: 'remote-admin.get-desktop-host-status' }), /No running Pi GUI Host/u)
})

test('a socket left by an ended Host is replaced', linux, async (t) => {
  const directory = await dataDirectory(t)
  // A child listens on the socket and is killed, leaving the file with no listener.
  const child = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:net')
    require('node:fs').mkdirSync(${JSON.stringify(directory)}, { recursive: true })
    createServer().listen(${JSON.stringify(hostControlSocketPath(directory))}, () => process.send('ready'))
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await new Promise((resolve) => child.once('message', resolve))
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  assert.ok((await stat(hostControlSocketPath(directory))).isSocket())

  const control = await openHostControl({ userDataDirectory: directory, dispatch: async () => 'owned' })
  t.after(() => control.close())
  assert.equal(await requestHostControl(directory, { type: 'remote-admin.get-desktop-host-status' }), 'owned')
})

test('malformed and oversized requests are rejected without dispatch', linux, async (t) => {
  const directory = await dataDirectory(t)
  let dispatched = 0
  const control = await openHostControl({ userDataDirectory: directory, dispatch: async () => { dispatched += 1 } })
  t.after(() => control.close())
  const raw = (payload: string) => new Promise<string>((resolve, reject) => {
    const socket = createConnection(hostControlSocketPath(directory))
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.once('end', () => resolve(text))
    socket.once('error', reject)
    socket.end(payload)
  })
  assert.match(await raw('not json'), /Host control request is invalid/u)
  assert.match(await raw(JSON.stringify({ type: 'remote-admin.get-desktop-host-status', pad: 'x'.repeat(8 * 1024) })), /too large/u)
  assert.equal(dispatched, 0)
})

test('overlong data directory paths are refused before binding', () => {
  assert.throws(() => hostControlSocketPath(`/${'x'.repeat(200)}`), /too long/u)
})
