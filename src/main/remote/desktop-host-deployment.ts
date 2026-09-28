import { constants } from 'node:fs'
import { access, chmod, copyFile, cp, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { inspectDesktopHost, inspectDesktopHostBuild, lockDesktopHostDirectory } from './desktop-host-launch.ts'
import { readBuildIdentityFile } from '../build-identity.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const HASH = /^[0-9a-f]{64}$/u
const PAYLOAD = ['out', 'extensions', 'node_modules', 'package.json', 'pnpm-lock.yaml']
type Release = { id: string; sourceDigest: string; artifactDigest: string; payloadDigest: string }
type Installation = { schemaVersion: 1; configurationDirectory: string; current: Release | null; previous: Release | null }

// This small stable bootstrap needs only Node built-ins. It selects one immutable
// release, then delegates validation and locking to that release's bundled CLI.
const BOOTSTRAP = `import { readSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
try {
  let state;
  try {
    const fd = openSync(join(root, 'installation.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 511) !== 384 || info.size > 16384) throw new Error('Invalid installation record');
      const bytes = Buffer.alloc(16385);
      let count = 0;
      while (count < bytes.length) { const length = readSync(fd, bytes, count, bytes.length - count, null); if (!length) break; count += length; }
      if (count > 16384) throw new Error('Installation record is too large');
      state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
    } finally { closeSync(fd); }
  }
  catch { throw new Error('Cannot read Desktop Host installation record.'); }
  if (state?.schemaVersion !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(state.current?.id) || typeof state.configurationDirectory !== 'string') throw new Error('No valid Desktop Host release is installed.');
  const release = join(root, 'releases', state.current.id);
  const child = spawn(join(release, 'runtime/node'), [join(release, 'out/main/desktop-host-cli.js'), ...process.argv.slice(2), '--config-dir', state.configurationDirectory, '--install-dir', root], { stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('close', (code) => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.exitCode = code ?? 1; });
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
`

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
}

function parseInstallation(value: unknown, configurationDirectory: string): Installation {
  const validRelease = (value: unknown): value is Release => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Release
    return Object.keys(record).length === 4 && typeof record.id === 'string' && UUID.test(record.id) &&
      [record.sourceDigest, record.artifactDigest, record.payloadDigest].every(hash => typeof hash === 'string' && HASH.test(hash))
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Host installation record.')
  const state = value as Installation
  if (Object.keys(state).length !== 4 || state.schemaVersion !== 1 || state.configurationDirectory !== configurationDirectory ||
    !(state.current === null || validRelease(state.current)) || !(state.previous === null || validRelease(state.previous)) ||
    (state.current === null && state.previous !== null) || (state.current !== null && state.current.id === state.previous?.id)) {
    throw new Error('Invalid Host installation record or configuration directory does not own this installation.')
  }
  return state
}

async function readInstallation(root: string, configurationDirectory: string): Promise<Installation | null> {
  let file
  try { file = await open(join(root, 'installation.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 || info.size > 16_384) throw new Error('Host installation record must be a private bounded regular file.')
    const bytes = Buffer.alloc(16_385)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null)
      if (bytesRead === 0) break
      count += bytesRead
    }
    if (count > 16_384) throw new Error('Host installation record is too large.')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) }
    catch { throw new Error('Host installation record is not valid UTF-8 JSON.') }
    return parseInstallation(value, configurationDirectory)
  } finally { await file.close() }
}

async function saveInstallation(root: string, state: Installation): Promise<void> {
  parseInstallation(state, state.configurationDirectory)
  const temporary = join(root, `.installation.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    try { await file.writeFile(`${JSON.stringify(state)}\n`); await file.sync() }
    finally { await file.close() }
    await rename(temporary, join(root, 'installation.json'))
  } catch (error) {
    try { await unlink(temporary) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Installation record write and cleanup failed.') }
    throw error
  }
}

/** Hash every shipped file and link; never follow a dependency outside the release. */
export async function desktopHostPayloadDigest(root: string, includeNode: boolean): Promise<string> {
  return desktopHostFilesDigest(root, [...PAYLOAD, ...(includeNode ? ['runtime'] : [])])
}

/** Also used to compare the selected runtime files before and after packaging. */
export async function desktopHostFilesDigest(root: string, paths: string[], excluded: string[] = []): Promise<string> {
  const digest = createHash('sha256')
  const ignored = new Set(excluded)
  const buffer = Buffer.allocUnsafe(128 * 1024)
  let entries = 0, bytes = 0
  const visit = async (path: string, depth: number): Promise<void> => {
    if (ignored.has(path)) return
    if (++entries > 150_000 || depth > 64) throw new Error('Host payload exceeds the file count or depth limit.')
    const absolute = join(root, path), info = await lstat(absolute)
    if (info.isSymbolicLink()) {
      if (!inside(root, await realpath(absolute))) throw new Error(`Host dependency link escapes the release: ${path}`)
      digest.update(JSON.stringify([path, 'link', await readlink(absolute)]))
    } else if (info.isDirectory()) {
      digest.update(JSON.stringify([path, 'directory']))
      for (const name of (await readdir(absolute)).sort()) await visit(`${path}/${name}`, depth + 1)
    } else if (info.isFile()) {
      bytes += info.size
      if (bytes > 4 * 1024 ** 3) throw new Error('Host payload exceeds 4 GiB.')
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await file.stat()
        if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size !== info.size) throw new Error(`Host payload changed while reading: ${path}`)
        const hash = createHash('sha256')
        let total = 0
        while (true) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > info.size) throw new Error(`Host payload grew while reading: ${path}`)
          hash.update(buffer.subarray(0, bytesRead))
        }
        const after = await file.stat()
        if (total !== info.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Host payload changed while reading: ${path}`)
        digest.update(JSON.stringify([path, 'file', info.mode & 0o111, hash.digest('hex')]))
      } finally { await file.close() }
    } else throw new Error(`Unsupported Host payload file: ${path}`)
  }
  for (const path of [...paths].sort()) await visit(path, 0)
  return digest.digest('hex')
}

async function privateInstallRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new Error('Use an absolute Host installation directory.')
  const info = await lstat(root)
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o700) throw new Error('Host installation directory must be a non-symlink private 0700 directory.')
  return realpath(root)
}

async function verifyReleasePayload(root: string, release: Release): Promise<string> {
  const path = join(root, 'releases', release.id)
  await privateInstallRoot(join(root, 'releases'))
  await privateInstallRoot(path)
  const inspected = await inspectDesktopHostBuild(path)
  if (inspected.sourceDigest !== release.sourceDigest || inspected.artifactDigest !== release.artifactDigest ||
      await desktopHostPayloadDigest(path, true) !== release.payloadDigest) throw new Error('Installed Host payload changed. Restore the release or roll back before starting or deploying.')
  return path
}

/** Called under the configuration lock by managed start, so selection cannot race deployment. */
export async function resolveInstalledDesktopHost(directory: string, installDirectory: string): Promise<string> {
  const root = await privateInstallRoot(installDirectory)
  const state = await readInstallation(root, await realpath(directory))
  if (!state?.current) throw new Error('No Desktop Host release is installed. Run deploy first.')
  const path = await verifyReleasePayload(root, state.current)
  await inspectDesktopHost(directory, path)
  return path
}

export async function deployDesktopHost(options: {
  directory: string; installDirectory: string; buildRoot: string;
  expectedPayloadDigest?: string;
  onProgress?: (stage: 'checking-source' | 'checking-current' | 'copying' | 'verifying-candidate' | 'activating' | 'reusing-current') => void;
}) {
  const configurationLock = await lockDesktopHostDirectory(options.directory)
  try {
    options.onProgress?.('checking-source')
    const inspected = await inspectDesktopHost(options.directory, options.buildRoot)
    await access(join(inspected.root, 'out/main/desktop-host-cli.js'))
    if (!readBuildIdentityFile(join(inspected.root, 'out/main/build-identity.json'))?.files['out/main/desktop-host-cli.js']) throw new Error('Rebuild the Linux application with the managed Host CLI before deploying.')
    const configurationDirectory = await realpath(options.directory)
    if (inside(inspected.root, resolve(options.installDirectory)) || inside(resolve(options.installDirectory), inspected.root)) throw new Error('Build and installation directories must not overlap.')
    const installLock = await lockDesktopHostDirectory(options.installDirectory, true)
    try {
      const root = await privateInstallRoot(options.installDirectory)
      if (inside(inspected.root, root) || inside(root, inspected.root)) throw new Error('Build and installation directories must not overlap.')
      let state = await readInstallation(root, configurationDirectory)
      if (state === null) {
        state = { schemaVersion: 1, configurationDirectory, current: null, previous: null }
        // Persist the owner before creating a candidate, including on an interrupted first install.
        await saveInstallation(root, state)
      }
      const bootstrap = join(root, 'host.mjs')
      await writeBootstrap(bootstrap)
      await mkdir(join(root, 'releases'), { mode: 0o700, recursive: true })
      await privateInstallRoot(join(root, 'releases'))
      // Both locks are held, so an earlier incomplete copy has no live owner.
      for (const name of await readdir(join(root, 'releases'))) {
        if (name.startsWith('.candidate-') && UUID.test(name.slice('.candidate-'.length))) {
          const stale = join(root, 'releases', name)
          await privateInstallRoot(stale)
          await rm(stale, { recursive: true })
        }
      }
      const before = await desktopHostPayloadDigest(inspected.root, false)
      if (state.current !== null) {
        options.onProgress?.('checking-current')
        // Only a verified current release can become the rollback target. Repair a
        // damaged installation by explicitly rolling back before deploying again.
        const current = await verifyReleasePayload(root, state.current)
        if (state.current.sourceDigest === inspected.sourceDigest && state.current.artifactDigest === inspected.artifactDigest &&
            (options.expectedPayloadDigest === undefined || state.current.payloadDigest === options.expectedPayloadDigest) &&
            before === await desktopHostPayloadDigest(current, false)) {
          options.onProgress?.('reusing-current')
          await inspectDesktopHost(options.directory, current)
          return { installed: true, reused: true, root, release: state.current, previous: state.previous, launcher: join(root, 'host.mjs') }
        }
      }
      const id = randomUUID(), candidate = join(root, 'releases', `.candidate-${id}`), destination = join(root, 'releases', id)
      await mkdir(candidate, { mode: 0o700 })
      let renamed = false, committed = false
      try {
        options.onProgress?.('copying')
        for (const path of PAYLOAD) await cp(join(inspected.root, path), join(candidate, path), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })
        options.onProgress?.('verifying-candidate')
        if (before !== await desktopHostPayloadDigest(candidate, false) || before !== await desktopHostPayloadDigest(inspected.root, false)) throw new Error('Host payload changed during deployment. The current release was not replaced.')
        await mkdir(join(candidate, 'runtime'), { mode: 0o700 })
        await copyFile(process.execPath, join(candidate, 'runtime/node'), constants.COPYFILE_EXCL)
        await chmod(join(candidate, 'runtime/node'), 0o700)
        const copied = await inspectDesktopHost(options.directory, candidate)
        if (copied.sourceDigest !== inspected.sourceDigest || copied.artifactDigest !== inspected.artifactDigest) throw new Error('Candidate build differs from the selected source.')
        const release: Release = { id, sourceDigest: copied.sourceDigest, artifactDigest: copied.artifactDigest, payloadDigest: await desktopHostPayloadDigest(candidate, true) }
        if (options.expectedPayloadDigest !== undefined && release.payloadDigest !== options.expectedPayloadDigest) throw new Error('Candidate differs from the verified Host bundle. The current release was not replaced.')
        options.onProgress?.('activating')
        // Pairing data is outside the copied payload. Recheck it after the copy
        // and full digest pass, while still holding the configuration lock.
        await inspectDesktopHost(options.directory, candidate)
        await rename(candidate, destination); renamed = true
        await saveInstallation(root, { ...state, current: release, previous: state.current }); committed = true
        return { installed: true, reused: false, root, release, previous: state.current, launcher: join(root, 'host.mjs') }
      } catch (error) {
        if (!committed) {
          try { await rm(renamed ? destination : candidate, { recursive: true, force: true }) }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Deployment failed and its candidate could not be removed.') }
        }
        throw error
      }
    } finally { await installLock.close() }
  } finally { await configurationLock.close() }
}

async function writeBootstrap(path: string): Promise<void> {
  let exists = true
  try { await lstat(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }
  if (exists) {
    const info = await lstat(path)
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 || info.size !== Buffer.byteLength(BOOTSTRAP) || await readFile(path, 'utf8') !== BOOTSTRAP) throw new Error('Existing Host bootstrap differs; restore it before deploying.')
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try { await file.writeFile(BOOTSTRAP); await file.sync() }
    finally { await file.close() }
    await rename(temporary, path)
  } catch (error) {
    try { await unlink(temporary) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Bootstrap write and cleanup failed.') }
    throw error
  }
}

export async function rollbackDesktopHost(directory: string, installDirectory: string) {
  const configurationLock = await lockDesktopHostDirectory(directory)
  try {
    const installLock = await lockDesktopHostDirectory(installDirectory)
    try {
      const root = await privateInstallRoot(installDirectory)
      const state = await readInstallation(root, await realpath(directory))
      if (!state?.previous) throw new Error('No previous Desktop Host release is available.')
      const previous = await verifyReleasePayload(root, state.previous)
      await inspectDesktopHost(directory, previous)
      await saveInstallation(root, { ...state, current: state.previous, previous: state.current })
      return { rolledBack: true, root, release: state.previous, previous: state.current, launcher: join(root, 'host.mjs') }
    } finally { await installLock.close() }
  } finally { await configurationLock.close() }
}
