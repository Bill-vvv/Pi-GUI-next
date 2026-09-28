import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { isDesktopClientCommand } from '../../shared/desktop-client-contract.ts'
import { discoverSshHosts } from './ssh-host-discovery.ts'
import { parseWindowsRemoteHostConfig } from './windows-remote-host-config.ts'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), 'pi-ssh-discovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const base = join(home, '.ssh')
  const system = join(home, 'system')
  await mkdir(base)
  await mkdir(system)
  const roots = [
    { filePath: join(base, 'config'), includeBase: base },
    { filePath: join(system, 'ssh_config'), includeBase: system }
  ]
  return { home, base, system, roots, discover: () => discoverSshHosts(roots, home) }
}

test('discovers static aliases with ordered nested Includes, quotes, equals, comments and system roots', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.base, '目录 with spaces'))
  await writeFile(f.roots[0]!.filePath, '# header\r\nHost=alpha beta * !excluded dev-*\r\nHostName secret.example\r\nInclude "目录 with spaces/*.conf"\r\nhOsT "last" # comment\r\n')
  await writeFile(join(f.base, '目录 with spaces', '2.conf'), 'Host beta second\nInclude nested.conf\n')
  await writeFile(join(f.base, '目录 with spaces', '1.conf'), 'Host first\n')
  await writeFile(join(f.base, 'nested.conf'), 'Host nested\n')
  await writeFile(f.roots[1]!.filePath, 'Host system\nInclude system.conf\n')
  await writeFile(join(f.system, 'system.conf'), 'Host system-child\n')
  const result = await f.discover()
  assert.deepEqual(result.hosts.map((host) => host.alias), ['alpha', 'beta', 'first', 'second', 'nested', 'last', 'system', 'system-child'])
  assert.deepEqual(result.hosts[0], { alias: 'alpha', filePath: f.roots[0]!.filePath, line: 2 })
  assert.deepEqual(result.searchedFiles, f.roots.map((root) => root.filePath))
  assert.deepEqual(result.warnings, [])
  assert.ok(!JSON.stringify(result).includes('secret.example'))
  for (const host of result.hosts) assert.equal(parseWindowsRemoteHostConfig({ sshHostAlias: host.alias, localPort: 18788, desktopHostPort: 18788 }).sshHostAlias, host.alias)
})

test('Match and proxy commands are inventory data and never run; conditional includes remain explicitly unverified', async (t) => {
  const f = await fixture(t)
  const marker = join(f.home, 'must-not-exist')
  await writeFile(f.roots[0]!.filePath, `Host safe\nMatch exec "echo unsafe > ${marker}"\nInclude conditional.conf\nProxyCommand echo private-command\nIdentityFile private-key\nLocalCommand echo unsafe\n`)
  await writeFile(join(f.base, 'conditional.conf'), 'Host candidate\n')
  await writeFile(join(f.base, 'private-key'), 'Host private-key-must-not-be-read\n')
  const result = await f.discover()
  assert.deepEqual(result.hosts.map((host) => host.alias), ['safe', 'candidate'])
  assert.match(result.warnings.join('\n'), /Match/u)
  assert.ok(!JSON.stringify(result).includes('private-command'))
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('missing config is an honest empty inventory; malformed and dynamic Includes are visible and refresh reads current bytes', async (t) => {
  const f = await fixture(t)
  assert.deepEqual((await f.discover()).hosts, [])
  await writeFile(f.roots[0]!.filePath, 'Host "unterminated\nHost -oEvil user@host good\nInclude ${SECRET}/config %h.conf missing.conf\n')
  const listing = await f.discover()
  assert.deepEqual(listing.hosts.map((host) => host.alias), ['good'])
  assert.match(listing.warnings.join('\n'), /格式无效/u)
  assert.match(listing.warnings.join('\n'), /不支持的 SSH 别名/u)
  assert.match(listing.warnings.join('\n'), /动态路径/u)
  assert.match(listing.warnings.join('\n'), /ENOENT/u)
  await writeFile(f.roots[0]!.filePath, 'Host replaced\n')
  assert.deepEqual((await f.discover()).hosts.map((host) => host.alias), ['replaced'])
})

test('supports home, absolute paths and bracket/one-character glob patterns without changing Include base', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.base, 'fragments'))
  await writeFile(join(f.base, 'fragments', 'a1.conf'), 'Host one\n')
  await writeFile(join(f.base, 'fragments', 'b2.conf'), 'Host two\n')
  await writeFile(join(f.base, 'fragments', 'c3.conf'), 'Host excluded\n')
  await writeFile(join(f.home, 'home.conf'), 'Host home\n')
  await writeFile(f.roots[0]!.filePath, `Include fragments/[ab]?.conf ~/home.conf "${join(f.home, 'home.conf')}"\n`)
  assert.deepEqual((await f.discover()).hosts.map((host) => host.alias), ['one', 'two', 'home'])
})

test('reports cycles, non-files and invalid encoding without hiding usable aliases', async (t) => {
  const f = await fixture(t)
  await writeFile(f.roots[0]!.filePath, 'Host good\nInclude config . invalid.conf\n')
  await writeFile(join(f.base, 'invalid.conf'), Buffer.from([0xff, 0xfe]))
  const result = await f.discover()
  assert.deepEqual(result.hosts.map((host) => host.alias), ['good'])
  assert.match(result.warnings.join('\n'), /循环/u)
  assert.match(result.warnings.join('\n'), /不是普通文件|无法读取 UTF-8/u)
  assert.match(result.warnings.join('\n'), /UTF-8/u)
})

test('canonical identity detects a symlink Include cycle', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t)
  await writeFile(f.roots[0]!.filePath, 'Host good\nInclude loop.conf\n')
  await symlink(f.roots[0]!.filePath, join(f.base, 'loop.conf'))
  assert.match((await f.discover()).warnings.join('\n'), /循环/u)
})

test('discovery rejects byte and host limits instead of returning a silently truncated list', async (t) => {
  const f = await fixture(t)
  await writeFile(f.roots[0]!.filePath, `#${'x'.repeat(1024 * 1024)}`)
  await assert.rejects(f.discover(), /1 MiB/u)
  await writeFile(f.roots[0]!.filePath, Array.from({ length: 257 }, (_, i) => `Host host-${i}`).join('\n'))
  await assert.rejects(f.discover(), /256/u)
})

test('discovery bounds Include depth and repeated file traversal', async (t) => {
  const f = await fixture(t)
  await writeFile(f.roots[0]!.filePath, 'Include 0.conf\n')
  for (let i = 0; i < 9; i++) await writeFile(join(f.base, `${i}.conf`), `Include ${i + 1}.conf\n`)
  await assert.rejects(f.discover(), /8 层/u)
  await writeFile(f.roots[0]!.filePath, `Include ${Array(65).fill('last.conf').join(' ')}\n`)
  await writeFile(join(f.base, 'last.conf'), 'Host leaf\n')
  await assert.rejects(f.discover(), /64/u)
})

test('discovery IPC accepts no caller-supplied paths, commands or other options', () => {
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.list-ssh-hosts' }), true)
  for (const field of ['path', 'roots', 'exec', 'sshHostAlias', 'command']) {
    assert.equal(isDesktopClientCommand({ type: 'desktop-client.list-ssh-hosts', [field]: 'untrusted' }), false)
  }
})

test('discovered literal aliases agree with system OpenSSH using an isolated configuration and no connection', async (t) => {
  const f = await fixture(t)
  const fragments = join(f.base, '中文 fragments')
  await mkdir(fragments)
  await writeFile(f.roots[0]!.filePath, `Include "${fragments.replaceAll('\\', '/')}/[ab]?.conf"\nHost=final\n  HostName final.example.invalid\n`)
  await writeFile(join(fragments, 'a1.conf'), 'Host "first"\n  HostName first.example.invalid\n')
  await writeFile(join(fragments, 'b2.conf'), 'Host second # inline comment\n  HostName second.example.invalid\n')
  if (process.platform === 'win32') {
    // OpenSSH checks included-file ACLs even with -G. Restrict only this disposable fixture.
    await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [
      f.home, '/inheritance:r', '/grant:r', `${userInfo().username}:F`, '/T'
    ], { windowsHide: true, timeout: 10_000 })
  }
  const listing = await f.discover()
  assert.deepEqual(listing.hosts.map((host) => host.alias), ['first', 'second', 'final'])
  const ssh = process.platform === 'win32' ? join(process.env.SystemRoot!, 'System32', 'OpenSSH', 'ssh.exe') : 'ssh'
  for (const host of listing.hosts) {
    const { stdout } = await promisify(execFile)(ssh, ['-G', '-F', f.roots[0]!.filePath, host.alias], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true
    })
    assert.ok(stdout.split(/\r?\n/u).includes(`hostname ${host.alias}.example.invalid`))
  }
})
