import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DESKTOP_HOST_BIND_HOST,
  loadDesktopHostConfig
} from './desktop-host-config.ts'

const uid = process.getuid!()

async function withTokenFile(run: (tokenFile: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-desktop-host-token-'))
  try {
    const tokenFile = join(directory, 'token')
    await writeFile(tokenFile, 'd'.repeat(32), { mode: 0o600 })
    await chmod(tokenFile, 0o600)
    await run(tokenFile)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('Desktop Host stays disabled unless explicitly enabled', async () => {
  assert.deepEqual(await loadDesktopHostConfig({}), { enabled: false })
})

test('Desktop Host uses a fixed loopback bind and dedicated device store', async () => {
  await withTokenFile(async (tokenFile) => {
    const config = await loadDesktopHostConfig({
      PI_GUI_DESKTOP_HOST_ENABLED: '1',
      PI_GUI_DESKTOP_HOST_PORT: '18788',
      PI_GUI_DESKTOP_HOST_TOKEN_FILE: tokenFile
    }, { uid })
    assert.equal(config.enabled, true)
    if (!config.enabled) return
    assert.equal(config.bindHost, DESKTOP_HOST_BIND_HOST)
    assert.equal(config.port, 18788)
    assert.equal(config.token, 'd'.repeat(32))
    assert.equal(config.tokenFile, tokenFile)
    assert.equal(config.deviceStorePath, `${tokenFile}.desktop-device`)
  })
})

test('Desktop Host rejects bad ports, relative token paths, and unsafe token files', async () => {
  await withTokenFile(async (tokenFile) => {
    const base = {
      PI_GUI_DESKTOP_HOST_ENABLED: '1',
      PI_GUI_DESKTOP_HOST_PORT: '18788',
      PI_GUI_DESKTOP_HOST_TOKEN_FILE: tokenFile
    }
    await assert.rejects(
      () => loadDesktopHostConfig({ ...base, PI_GUI_DESKTOP_HOST_PORT: '0' }, { uid }),
      /exact integer port/
    )
    await assert.rejects(
      () => loadDesktopHostConfig({ ...base, PI_GUI_DESKTOP_HOST_PORT: '65536' }, { uid }),
      /exact integer port/
    )
    await assert.rejects(
      () => loadDesktopHostConfig({
        ...base,
        PI_GUI_DESKTOP_HOST_TOKEN_FILE: 'relative-token'
      }, { uid }),
      /absolute path/
    )
    await chmod(tokenFile, 0o644)
    await assert.rejects(
      () => loadDesktopHostConfig(base, { uid }),
      /PI_GUI_DESKTOP_HOST_TOKEN_FILE must have mode 0600/
    )
  })
})
