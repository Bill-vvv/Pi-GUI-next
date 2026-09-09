import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWindowsRemoteHostConfig } from './windows-remote-host-config.ts'

test('Windows remote host config accepts one strict SSH alias and two ports', () => {
  assert.deepEqual(parseWindowsRemoteHostConfig({
    sshHostAlias: 'pi-linux.home',
    localPort: 18788,
    desktopHostPort: 18788
  }), {
    sshHostAlias: 'pi-linux.home',
    localPort: 18788,
    desktopHostPort: 18788
  })
})

test('Windows remote host config rejects option injection, destinations, extra fields, and invalid ports', () => {
  for (const sshHostAlias of ['-Fbad', 'user@host', 'host:22', '', 'alias with spaces']) {
    assert.throws(() => parseWindowsRemoteHostConfig({
      sshHostAlias,
      localPort: 18788,
      desktopHostPort: 18788
    }), /SSH host alias/)
  }
  assert.throws(() => parseWindowsRemoteHostConfig({
    sshHostAlias: 'pi-linux',
    localPort: 0,
    desktopHostPort: 18788
  }), /localPort/)
  assert.throws(() => parseWindowsRemoteHostConfig({
    sshHostAlias: 'pi-linux',
    localPort: 18788,
    desktopHostPort: 65_536
  }), /desktopHostPort/)
  assert.throws(() => parseWindowsRemoteHostConfig({
    sshHostAlias: 'pi-linux',
    localPort: 18788,
    desktopHostPort: 18788,
    credential: 'must-not-enter-connection-config'
  }), /exactly/)
})
