import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createTailscaleRemoteGatewayConfig,
  openTailscaleRemoteManager,
  type RunTailscaleCommand
} from './tailscale-remote.ts'

const DNS_NAME = 'pi-host.example.ts.net'

test('Tailscale manager detects a ready node and keeps the default mode off', async () => {
  const fixture = await createFixture()
  const status = await fixture.manager.getStatus()

  assert.deepEqual(status, {
    installed: true,
    backendState: 'Running',
    dnsName: DNS_NAME,
    authUrl: null,
    managedMode: 'off',
    routeState: 'off',
    publicOrigin: null
  })
})

test('Tailscale manager creates a 0600 token and enables Funnel on HTTPS 443', async () => {
  const fixture = await createFixture()
  const prepared = await fixture.manager.prepareEnable('funnel')
  const token = await fixture.manager.ensureToken()
  const status = await fixture.manager.activate(prepared, 32123)

  assert.equal(token.length, 64)
  assert.equal((await stat(fixture.tokenFile)).mode & 0o777, 0o600)
  assert.equal((await stat(fixture.configPath)).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(await readFile(fixture.configPath, 'utf8')), {
    version: 1,
    mode: 'funnel',
    publicOrigin: `https://${DNS_NAME}`,
    port: 32123
  })
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'funnel'), [
    'funnel',
    '--bg',
    '--yes',
    '--https=443',
    'http://127.0.0.1:32123'
  ])
  assert.equal(status.managedMode, 'funnel')
  assert.equal(status.routeState, 'active')
  assert.equal(status.publicOrigin, `https://${DNS_NAME}`)
})

test('Tailscale manager switches its exact Funnel route to Serve without reset', async () => {
  const fixture = await createFixture()
  const funnel = await fixture.manager.prepareEnable('funnel')
  await fixture.manager.ensureToken()
  await fixture.manager.activate(funnel, 32123)

  const serve = await fixture.manager.prepareEnable('serve')
  await fixture.manager.activate(serve, 32123)

  assert.deepEqual(fixture.calls.filter((args) => args[args.length - 1] === 'off'), [
    ['funnel', '--https=443', 'off']
  ])
  assert.equal(fixture.calls.some((args) => args.includes('reset')), false)
  const status = await fixture.manager.getStatus()
  assert.equal(status.managedMode, 'serve')
  assert.equal(status.routeState, 'active')
})

test('managed startup preparation rejects DNS changes and unknown route replacement', async () => {
  const fixture = await createFixture()
  const prepared = await fixture.manager.prepareEnable('funnel')
  await fixture.manager.ensureToken()
  await fixture.manager.activate(prepared, 32123)

  fixture.setDnsName('renamed-host.example.ts.net')
  await assert.rejects(
    fixture.manager.prepareEnable('funnel'),
    /主机名已变化/u
  )

  fixture.setDnsName(DNS_NAME)
  fixture.setServeConfig(serveConfigWithUnknownHandler('http://127.0.0.1:32123', 'funnel'))
  await assert.rejects(
    fixture.manager.prepareEnable('funnel'),
    /非 Pi GUI/u
  )

  fixture.setServeConfig(serveConfigFor('http://127.0.0.1:9999', 'funnel'))
  await assert.rejects(
    fixture.manager.prepareEnable('funnel'),
    /非 Pi GUI/u
  )
})

test('managed startup restores a missing exact route without changing origin or port', async () => {
  const fixture = await createFixture()
  const prepared = await fixture.manager.prepareEnable('funnel')
  await fixture.manager.ensureToken()
  await fixture.manager.activate(prepared, 32123)

  fixture.setServeConfig({})
  const restore = await fixture.manager.prepareEnable('funnel')
  const restored = await fixture.manager.activate(restore, 32123)

  assert.equal(restored.managedMode, 'funnel')
  assert.equal(restored.routeState, 'active')
  assert.equal(restored.publicOrigin, `https://${DNS_NAME}`)
  assert.equal(fixture.calls.filter((args) => args[0] === 'funnel' && args.includes('--bg')).length, 2)
})

test('Tailscale manager refuses to overwrite an existing HTTPS 443 route', async () => {
  const fixture = await createFixture({
    initialServeConfig: serveConfigFor('http://127.0.0.1:9999', 'serve')
  })

  await assert.rejects(
    fixture.manager.prepareEnable('funnel'),
    /non Pi GUI|非 Pi GUI/u
  )
  assert.equal(fixture.calls.some((args) => args[0] === 'funnel' && args.includes('--bg')), false)
})

test('Tailscale manager disables only its owned route and removes managed files explicitly', async () => {
  const fixture = await createFixture()
  const prepared = await fixture.manager.prepareEnable('funnel')
  await fixture.manager.ensureToken()
  await fixture.manager.activate(prepared, 32123)

  await fixture.manager.disableRoute()
  assert.deepEqual(fixture.calls.filter((args) => args[args.length - 1] === 'off'), [
    ['funnel', '--https=443', 'off']
  ])
  await fixture.manager.clearManagedFiles()

  const status = await fixture.manager.getStatus()
  assert.equal(status.managedMode, 'off')
  assert.equal(status.routeState, 'off')
  await assert.rejects(stat(fixture.configPath), { code: 'ENOENT' })
  await assert.rejects(stat(fixture.tokenFile), { code: 'ENOENT' })
})

test('Tailscale Remote gateway config is loopback-only and trusts only loopback proxying', () => {
  const config = createTailscaleRemoteGatewayConfig({
    publicOrigin: `https://${DNS_NAME}`,
    port: 0,
    token: 'x'.repeat(64),
    tokenFile: '/tmp/pi-gui-tailscale.token'
  })

  assert.deepEqual(config, {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 0,
    publicOrigin: `https://${DNS_NAME}`,
    publicHost: DNS_NAME,
    trustedProxyIp: '127.0.0.1',
    token: 'x'.repeat(64),
    tokenFile: '/tmp/pi-gui-tailscale.token',
    deviceStorePath: '/tmp/pi-gui-tailscale.token.device'
  })
})

async function createFixture(options: {
  initialServeConfig?: Record<string, unknown>
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-tailscale-'))
  const configPath = join(directory, 'tailscale-remote.json')
  const tokenFile = join(directory, 'tailscale-remote.token')
  const calls: string[][] = []
  let dnsName = DNS_NAME
  let serveConfig = structuredClone(options.initialServeConfig ?? {})

  const runCommand: RunTailscaleCommand = async (args) => {
    calls.push([...args])
    if (args[0] === 'status') {
      return {
        stdout: JSON.stringify({
          BackendState: 'Running',
          AuthURL: '',
          Self: { DNSName: `${dnsName}.` }
        }),
        stderr: ''
      }
    }
    if (args[0] === 'serve' && args[1] === 'status') {
      return { stdout: JSON.stringify(serveConfig), stderr: '' }
    }
    if ((args[0] === 'serve' || args[0] === 'funnel') && args[args.length - 1] === 'off') {
      serveConfig = {}
      return { stdout: '', stderr: '' }
    }
    if ((args[0] === 'serve' || args[0] === 'funnel') && args.includes('--bg')) {
      const target = args[args.length - 1]!
      serveConfig = serveConfigFor(target, args[0])
      return { stdout: '', stderr: '' }
    }
    throw new Error(`Unexpected Tailscale command: ${args.join(' ')}`)
  }

  const manager = await openTailscaleRemoteManager({
    configPath,
    tokenFile,
    uid: process.getuid!(),
    runCommand
  })
  return {
    manager,
    configPath,
    tokenFile,
    calls,
    setDnsName(value: string) {
      dnsName = value
    },
    setServeConfig(value: Record<string, unknown>) {
      serveConfig = structuredClone(value)
    }
  }
}

function serveConfigWithUnknownHandler(
  target: string,
  mode: 'serve' | 'funnel'
): Record<string, unknown> {
  const config = serveConfigFor(target, mode)
  const web = config.Web as Record<string, { Handlers: Record<string, Record<string, unknown>> }>
  web[`${DNS_NAME}:443`]!.Handlers['/']!.Unexpected = true
  return config
}

function serveConfigFor(target: string, mode: 'serve' | 'funnel'): Record<string, unknown> {
  const hostPort = `${DNS_NAME}:443`
  return {
    TCP: {
      443: { HTTPS: true }
    },
    Web: {
      [hostPort]: {
        Handlers: {
          '/': { Proxy: `${target}/` }
        }
      }
    },
    ...(mode === 'funnel'
      ? { AllowFunnel: { [hostPort]: true } }
      : {})
  }
}
