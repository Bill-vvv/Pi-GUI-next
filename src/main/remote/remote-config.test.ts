import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadRemoteConfig, readRemoteTokenFile } from './remote-config.ts'
import { deriveRemoteDeviceStorePath } from './remote-device-store.ts'

const uid = process.getuid!()

async function withTokenFile(
  mode: number,
  contents: string,
  run: (tokenFile: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-remote-token-'))
  try {
    const tokenFile = join(directory, 'token')
    await writeFile(tokenFile, contents, { mode })
    await chmod(tokenFile, mode)
    await run(tokenFile)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('remote stays disabled unless PI_GUI_REMOTE_ENABLED=1', async () => {
  const config = await loadRemoteConfig({})
  assert.deepEqual(config, { enabled: false })
})

test('enabled remote requires exact bind/port/origin/proxy/token file', async () => {
  await withTokenFile(0o600, `${'a'.repeat(32)}\n`, async (tokenFile) => {
    const config = await loadRemoteConfig({
      PI_GUI_REMOTE_ENABLED: '1',
      PI_GUI_REMOTE_BIND_HOST: '192.168.6.120',
      PI_GUI_REMOTE_PORT: '18787',
      PI_GUI_REMOTE_PUBLIC_ORIGIN: 'https://pi-gui.example.com',
      PI_GUI_REMOTE_TRUSTED_PROXY: '192.168.6.1',
      PI_GUI_REMOTE_TOKEN_FILE: tokenFile
    }, { uid })
    assert.equal(config.enabled, true)
    if (!config.enabled) return
    assert.equal(config.bindHost, '192.168.6.120')
    assert.equal(config.port, 18787)
    assert.equal(config.publicOrigin, 'https://pi-gui.example.com')
    assert.equal(config.publicHost, 'pi-gui.example.com')
    assert.equal(config.trustedProxyIp, '192.168.6.1')
    assert.equal(config.token, 'a'.repeat(32))
    assert.equal(config.tokenFile, tokenFile)
    assert.equal(config.deviceStorePath, deriveRemoteDeviceStorePath(tokenFile))
  })
})

test('token file must be regular, current-user owned, mode 0600, and one bounded line', async () => {
  await withTokenFile(0o644, 'a'.repeat(32), async (tokenFile) => {
    await assert.rejects(() => readRemoteTokenFile(tokenFile, uid), /mode 0600/)
  })
  await withTokenFile(0o600, 'short', async (tokenFile) => {
    await assert.rejects(() => readRemoteTokenFile(tokenFile, uid), /32 to 4096/)
  })
  await withTokenFile(0o600, `${'a'.repeat(32)}\ninside`, async (tokenFile) => {
    await assert.rejects(() => readRemoteTokenFile(tokenFile, uid), /one line/)
  })
  await withTokenFile(0o600, 'a'.repeat(4097), async (tokenFile) => {
    await assert.rejects(() => readRemoteTokenFile(tokenFile, uid), /32 to 4096/)
  })

  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-remote-token-link-'))
  try {
    const target = join(directory, 'target')
    const link = join(directory, 'link')
    await writeFile(target, 'a'.repeat(32), { mode: 0o600 })
    await chmod(target, 0o600)
    await symlink(target, link)
    await assert.rejects(() => readRemoteTokenFile(link, uid), /non-symlink/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('enabled remote rejects non-https origin, bad port, and non-exact proxy IP', async () => {
  await withTokenFile(0o600, 'a'.repeat(32), async (tokenFile) => {
    const base = {
      PI_GUI_REMOTE_ENABLED: '1',
      PI_GUI_REMOTE_BIND_HOST: '127.0.0.1',
      PI_GUI_REMOTE_PORT: '18787',
      PI_GUI_REMOTE_PUBLIC_ORIGIN: 'https://pi-gui.example.com',
      PI_GUI_REMOTE_TRUSTED_PROXY: '127.0.0.1',
      PI_GUI_REMOTE_TOKEN_FILE: tokenFile
    }
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_PUBLIC_ORIGIN: 'http://pi-gui.example.com' }, { uid }),
      /https origin/
    )
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_PUBLIC_ORIGIN: 'https://pi-gui.example.com/' }, { uid }),
      /https origin/
    )
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_PORT: '65536' }, { uid }),
      /port/
    )
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_BIND_HOST: 'pi-gui.local' }, { uid }),
      /exact IPv4/
    )
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_BIND_HOST: '0.0.0.0' }, { uid }),
      /wildcard/
    )
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_BIND_HOST: '::0' }, { uid }),
      /exact IPv4/
    )
    await assert.rejects(
      () => loadRemoteConfig({ ...base, PI_GUI_REMOTE_TRUSTED_PROXY: '192.168.6.0/24' }, { uid }),
      /exact IPv4/
    )
  })
})
