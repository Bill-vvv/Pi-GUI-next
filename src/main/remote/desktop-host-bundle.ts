import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { configureDesktopHost, inspectDesktopHostBuild } from './desktop-host-launch.ts'
import { deployDesktopHost, desktopHostPayloadDigest } from './desktop-host-deployment.ts'
import { copyHostRuntimePackages, hostRuntimePackageDigest, planHostRuntimePackages } from './desktop-host-runtime-package.ts'
import { readBuildIdentityFile } from '../build-identity.ts'

const INSTALLER = `#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$base/runtime/node" "$base/out/main/desktop-host-cli.js" install --build-root "$base" "$@"
`
const HASH = /^[0-9a-f]{64}$/u
type BundleManifest = {
  schemaVersion: 1; platform: 'linux'; arch: string; nodeVersion: string; productVersion: string;
  sourceDigest: string; artifactDigest: string; payloadDigest: string; packageCount: number;
  missingOptional: Array<{ from: string; name: string }>;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

/** Produce an offline archive from a prepared build; never alter that build. */
export async function packDesktopHost(options: {
  buildRoot: string; output: string; onProgress?: (stage: string) => void;
}) {
  if (!isAbsolute(options.output) || /[\\\0\r\n]/u.test(options.output) || !options.output.endsWith('.tar.gz')) throw new Error('Use an absolute .tar.gz output path without backslashes or line breaks.')
  const output = join(await realpath(dirname(options.output)), basename(options.output))
  // Check both publication paths before doing expensive work. link() below also
  // refuses concurrent writers instead of replacing an existing release archive.
  for (const path of [output, `${output}.sha256`]) {
    try { await lstat(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    throw new Error('Host bundle output already exists.')
  }
  options.onProgress?.('checking-build')
  const inspected = await inspectDesktopHostBuild(options.buildRoot)
  const outputSuffix = relative(inspected.root, output)
  if (outputSuffix !== '..' && !outputSuffix.startsWith('../') && !isAbsolute(outputSuffix)) throw new Error('Host bundle output must be outside the source build.')
  if (!readBuildIdentityFile(join(inspected.root, 'out/main/build-identity.json'))?.files['out/main/desktop-host-cli.js']) throw new Error('Rebuild with the managed Host CLI before packaging.')
  const plan = await planHostRuntimePackages(inspected.root)
  const before = await hostRuntimePackageDigest(plan)
  const temporary = await mkdtemp(join(tmpdir(), 'pi-host-bundle-'))
  let published = false, completed = false
  try {
    const stage = join(temporary, 'pi-gui-host')
    options.onProgress?.('copying-runtime')
    await copyHostRuntimePackages(plan, stage)
    for (const path of ['out', 'package.json', 'pnpm-lock.yaml']) await cp(join(inspected.root, path), join(stage, path), { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true })
    if (before !== await hostRuntimePackageDigest(plan, stage) || before !== await hostRuntimePackageDigest(plan) ||
        JSON.stringify(plan) !== JSON.stringify(await planHostRuntimePackages(inspected.root))) throw new Error('Runtime dependencies changed while packaging.')
    await mkdir(join(stage, 'runtime'), { mode: 0o700 })
    await copyFile(process.execPath, join(stage, 'runtime/node'), constants.COPYFILE_EXCL)
    await chmod(join(stage, 'runtime/node'), 0o700)
    const copied = await inspectDesktopHostBuild(stage)
    if (copied.sourceDigest !== inspected.sourceDigest || copied.artifactDigest !== inspected.artifactDigest) throw new Error('Build changed while packaging.')
    const manifest: BundleManifest = { schemaVersion: 1, platform: 'linux', arch: process.arch, nodeVersion: process.versions.node,
      productVersion: inspected.productVersion, sourceDigest: inspected.sourceDigest, artifactDigest: inspected.artifactDigest,
      payloadDigest: await desktopHostPayloadDigest(stage, true), packageCount: plan.packages.length, missingOptional: plan.missingOptional }
    await writeFile(join(stage, 'host-bundle.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(join(stage, 'install.sh'), INSTALLER, { flag: 'wx', mode: 0o700 })
    options.onProgress?.('verifying-bundle')
    await inspectDesktopHostBundle(stage)
    options.onProgress?.('compressing')
    // Stage and archive are private until complete. GNU tar writes only into our
    // already-open file and never dereferences the package's dependency links.
    const archive = join(temporary, 'host.tar.gz'), file = await open(archive, 'wx', 0o600)
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', '-', '-C', temporary, 'pi-gui-host'], { stdio: ['ignore', file.fd, 'pipe'] })
        let diagnostic = ''
        child.stderr!.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4096) })
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Host archive creation failed (${code}): ${diagnostic.trim()}`)))
      })
      await file.sync()
    } finally { await file.close() }
    const digest = await sha256(archive), bytes = (await lstat(archive)).size
    // Copy into the output filesystem before the exclusive atomic publication.
    const pending = await mkdtemp(join(dirname(output), '.host-bundle-'))
    try {
      await copyFile(archive, join(pending, 'archive'), constants.COPYFILE_EXCL)
      await writeFile(join(pending, 'checksum'), `${digest}  ${basename(output)}\n`, { flag: 'wx', mode: 0o600 })
      await link(join(pending, 'archive'), output); published = true
      await link(join(pending, 'checksum'), `${output}.sha256`)
      completed = true
    } finally { await rm(pending, { recursive: true }) }
    return { packed: true, output, checksum: `${output}.sha256`, sha256: digest, bytes, ...manifest }
  } finally {
    if (published && !completed) await unlink(output)
    await rm(temporary, { recursive: true })
  }
}

/** Validate an extracted bundle before touching the user's Host configuration. */
export async function inspectDesktopHostBundle(buildRoot: string) {
  const inspected = await inspectDesktopHostBuild(buildRoot)
  const file = await open(join(inspected.root, 'host-bundle.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let manifest: BundleManifest
  try {
    if (!(await file.stat()).isFile()) throw new Error('Host bundle manifest must be a regular file.')
    const bytes = Buffer.alloc(65_537)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null)
      if (!bytesRead) break
      count += bytesRead
    }
    if (count > 65_536) throw new Error('Host bundle manifest exceeds 64 KiB.')
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) }
    catch { throw new Error('Host bundle manifest is not valid UTF-8 JSON.') }
  } finally { await file.close() }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).length !== 10 ||
      manifest.schemaVersion !== 1 || manifest.platform !== 'linux' || manifest.arch !== process.arch || manifest.nodeVersion !== process.versions.node ||
      manifest.productVersion !== inspected.productVersion || manifest.sourceDigest !== inspected.sourceDigest || manifest.artifactDigest !== inspected.artifactDigest ||
      typeof manifest.payloadDigest !== 'string' || !HASH.test(manifest.payloadDigest) || !Number.isInteger(manifest.packageCount) || manifest.packageCount < 1 || manifest.packageCount > 4096 ||
      !Array.isArray(manifest.missingOptional) || manifest.missingOptional.some(item => item === null || typeof item !== 'object' || Object.keys(item).length !== 2 || typeof item.from !== 'string' || typeof item.name !== 'string')) throw new Error('Invalid or incompatible Host bundle manifest.')
  if (await desktopHostPayloadDigest(inspected.root, true) !== manifest.payloadDigest) throw new Error('Host bundle payload changed. Extract a verified archive again.')
  const installer = await lstat(join(inspected.root, 'install.sh'))
  if (!installer.isFile() || installer.size !== Buffer.byteLength(INSTALLER) || await readFile(join(inspected.root, 'install.sh'), 'utf8') !== INSTALLER) throw new Error('Host bundle installer changed.')
  const plan = await planHostRuntimePackages(inspected.root)
  if (plan.packages.length !== manifest.packageCount || JSON.stringify(plan.missingOptional) !== JSON.stringify(manifest.missingOptional)) throw new Error('Host bundle runtime dependency inventory differs.')
  return { ...inspected, manifest }
}

export async function installDesktopHostBundle(options: {
  buildRoot: string; directory: string; installDirectory: string; port?: number;
  onProgress?: (stage: string) => void;
}) {
  options.onProgress?.('verifying-bundle')
  const bundle = await inspectDesktopHostBundle(options.buildRoot)
  await configureDesktopHost(options.directory, options.port, { preserveExisting: true })
  const result = await deployDesktopHost({ ...options, expectedPayloadDigest: bundle.manifest.payloadDigest })
  // Complete releases are retained, so this Node path remains usable after upgrades.
  // The bootstrap selects the current release and its own Node on every invocation.
  return { ...result, nodeExecutable: join(result.root, 'releases', result.release.id, 'runtime/node') }
}
