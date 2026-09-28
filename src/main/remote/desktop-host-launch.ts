import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { readBuildIdentityFile, verifyBuildArtifacts } from '../build-identity.ts'
import { loadDesktopHostConfig, type DesktopHostEnabledConfig } from './desktop-host-config.ts'
import { assertDesktopHostDeviceStoreCompatible, desktopHostDeviceStoreVersions } from './desktop-host-data-compatibility.ts'
import { DesktopHostClient, DesktopHostClientError } from './desktop-host-client.ts'
import { checkLocalPort } from './desktop-host-preflight.ts'

type HostLaunchSettings = { schemaVersion: 1; port: number }

function parseSettings(value: unknown): HostLaunchSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !('schemaVersion' in value) || value.schemaVersion !== 1 ||
      !('port' in value) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) {
    throw new Error('Invalid Desktop Host launch settings.')
  }
  return value as HostLaunchSettings
}

function hostEnvironment(directory: string, settings: HostLaunchSettings): NodeJS.ProcessEnv {
  return {
    PI_GUI_DESKTOP_HOST_ENABLED: '1',
    PI_GUI_DESKTOP_HOST_PORT: String(settings.port),
    PI_GUI_DESKTOP_HOST_TOKEN_FILE: join(directory, 'desktop-host.token')
  }
}

async function validateConfiguration(directory: string, settings: HostLaunchSettings): Promise<DesktopHostEnabledConfig> {
  // Reject FIFOs before the shared reader opens the token; never block on a pipe.
  if (!(await lstat(join(directory, 'desktop-host.token'))).isFile()) throw new Error('Desktop Host token must be a regular non-symlink file.')
  const config = await loadDesktopHostConfig(hostEnvironment(directory, settings))
  if (!config.enabled) throw new Error('Managed Desktop Host configuration must be enabled.')
  return config
}

async function privateDirectory(directory: string, create: boolean): Promise<void> {
  if (process.platform !== 'linux' || process.getuid === undefined) throw new Error('Desktop Host launch requires Linux.')
  if (!isAbsolute(directory) || /[\0\r\n]/u.test(directory)) throw new Error('Use an absolute Desktop Host configuration directory.')
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Desktop Host configuration directory must be a non-symlink directory owned by you with mode 0700.')
  }
}

async function readSettings(directory: string): Promise<HostLaunchSettings> {
  const file = await open(join(directory, 'desktop-host.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 || info.size > 4096) {
      throw new Error('Desktop Host settings must be a regular 0600 file owned by you, at most 4096 bytes.')
    }
    const bytes = Buffer.alloc(4097)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, null)
      if (bytesRead === 0) break
      count += bytesRead
    }
    if (count > 4096) throw new Error('Desktop Host settings exceed 4096 bytes.')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) }
    catch { throw new Error('Desktop Host settings are not valid UTF-8 JSON.') }
    return parseSettings(value)
  } finally { await file.close() }
}

// flock locks the inherited open file description. The parent retains that lock
// until its handle closes, including while Electron is running; crashes release it.
export async function lockDesktopHostDirectory(directory: string, create = false): Promise<Awaited<ReturnType<typeof open>>> {
  await privateDirectory(directory, create)
  const file = await open(join(directory, 'desktop-host.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600) throw new Error('Invalid Desktop Host launch lock file.')
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', file.fd], timeout: 5000
    })
    if (result.error) throw result.error
    if (result.status === 1) throw new Error('Desktop Host launcher is busy. Close its running desktop before configuring or starting again.')
    if (result.status !== 0) throw new Error(`Desktop Host lock failed: ${result.stderr?.toString().trim() ?? result.signal}`)
    return file
  } catch (error) { await file.close(); throw error }
}

/** Prepare only local files; preserve an existing token and its paired device. */
export async function configureDesktopHost(directory: string, port?: number, options: { preserveExisting?: boolean } = {}): Promise<{ directory: string; port: number }> {
  const settings = parseSettings({ schemaVersion: 1, port: port ?? 18788 })
  await privateDirectory(directory, true)
  const lock = await lockDesktopHostDirectory(directory)
  try {
    let existing: HostLaunchSettings | undefined
    try {
      existing = await readSettings(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing && options.preserveExisting) {
      await validateConfiguration(directory, existing)
      if (port !== undefined && port !== existing.port) throw new Error('Existing Host uses another port. Change it explicitly with configure before installing.')
      return { directory, port: existing.port }
    }
    const tokenPath = join(directory, 'desktop-host.token')
    let tokenExists = true
    try { await lstat(tokenPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      tokenExists = false
    }
    if (!tokenExists) {
      if (existing) throw new Error('Configured Desktop Host token is missing. Restore it before changing settings.')
      try {
        await lstat(`${tokenPath}.desktop-device`)
        throw new Error('A paired-device record exists without its machine token. Restore the token before configuring.')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const token = await open(tokenPath, 'wx', 0o600)
      try { await token.writeFile(`${randomBytes(32).toString('hex')}\n`); await token.sync() }
      finally { await token.close() }
    }
    // Use the same token/permission/port checks as Linux Main before persisting.
    await validateConfiguration(directory, settings)
    const temporary = join(directory, `.desktop-host.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(`${JSON.stringify(settings)}\n`); await file.sync() }
      finally { await file.close() }
      await rename(temporary, join(directory, 'desktop-host.json'))
    } catch (error) {
      try { await unlink(temporary) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Host settings write and cleanup failed.') }
      throw error
    }
    return { directory, port: settings.port }
  } finally { await lock.close() }
}

/** Validate a prepared Linux build; this does not install dependencies or probe a running Host. */
export async function inspectDesktopHost(directory: string, buildRoot: string) {
  await privateDirectory(directory, false)
  const settings = await readSettings(directory)
  const config = await validateConfiguration(directory, settings)
  const inspected = await inspectDesktopHostBuild(buildRoot)
  await assertDesktopHostDeviceStoreCompatible(config.deviceStorePath, inspected.deviceStoreVersions)
  return { directory, port: settings.port, ...inspected }
}

export async function inspectDesktopHostBuild(buildRoot: string) {
  if (process.platform !== 'linux') throw new Error('Desktop Host build validation requires Linux.')
  if (!isAbsolute(buildRoot) || /[\0\r\n]/u.test(buildRoot)) throw new Error('Use an absolute Linux build directory.')
  const root = await realpath(buildRoot)
  const identity = readBuildIdentityFile(join(root, 'out/main/build-identity.json'))
  if (identity === null) throw new Error('Build manifest is missing. Build the Linux workspace first.')
  verifyBuildArtifacts(root, identity)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'pi-gui-next' || pkg.main !== './out/main/index.js') throw new Error('Expected a Pi GUI Linux build.')
  const deviceStoreVersions = desktopHostDeviceStoreVersions(pkg)
  if (process.versions.node !== pkg.engines?.node) throw new Error(`Use Node ${pkg.engines?.node} for this build.`)
  for (const [name, version] of [['electron', pkg.devDependencies?.electron], ['@earendil-works/pi-coding-agent', pkg.dependencies?.['@earendil-works/pi-coding-agent']]]) {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    if (typeof version !== 'string' || installed.version !== version) throw new Error(`Installed ${name} does not match the build. Install its frozen dependencies on Linux.`)
  }
  let executable: string
  try { executable = await realpath(join(root, 'node_modules/electron/dist/electron')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error('Linux Electron binary is missing. Install the pinned Electron runtime in this Linux build before starting.')
  }
  const binary = await open(executable, 'r')
  try {
    const header = Buffer.alloc(4)
    await binary.read(header, 0, 4, 0)
    if (!(await binary.stat()).isFile() || !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('The Electron runtime must be a Linux ELF executable. Do not use Windows node_modules.')
    }
  } finally { await binary.close() }
  await access(executable, constants.X_OK)
  const piExecutable = await realpath(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'))
  return { root, sourceDigest: identity.sourceDigest,
    artifactDigest: identity.artifactDigest, productVersion: pkg.version as string, executable, piExecutable, deviceStoreVersions }
}

/** Own one foreground Electron process and report ready only after the real handshake. */
export async function startDesktopHost(options: {
  directory: string; buildRoot: string | (() => Promise<string>); signal: AbortSignal;
  onReady: (status: Awaited<ReturnType<typeof inspectDesktopHost>>) => void;
}): Promise<void> {
  await privateDirectory(options.directory, false)
  const lock = await lockDesktopHostDirectory(options.directory)
  try {
    const root = typeof options.buildRoot === 'string' ? options.buildRoot : await options.buildRoot()
    const inspected = await inspectDesktopHost(options.directory, root)
    options.signal.throwIfAborted()
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new Error('Desktop Host currently requires a Linux graphical session. Start from that session; headless service mode is not available.')
    await checkLocalPort(inspected.port, options.signal)
    const env = { ...process.env, ...hostEnvironment(options.directory, { schemaVersion: 1, port: inspected.port }),
      PI_GUI_PI_EXECUTABLE: inspected.piExecutable, PI_GUI_DESKTOP_HOST_MANAGED: '1',
      // Pi's Linux entry uses /usr/bin/env node. Use the launcher's validated
      // Node for it too, including installations without a system Node.
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
    for (const name of ['ELECTRON_RUN_AS_NODE', 'PI_GUI_WSL_HOST', 'PI_GUI_WSL_DISTRO', 'PI_GUI_WSL_LAUNCHER',
      'PI_GUI_PROBE_ONLY', 'ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'NODE_OPTIONS']) delete (env as NodeJS.ProcessEnv)[name]
    const child = spawn(inspected.executable, [inspected.root], { cwd: inspected.root, env, stdio: ['inherit', 'inherit', 'inherit', lock.fd] })
    let ended = false
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once('error', (error) => { ended = true; resolve({ code: null, signal: null, error }) })
      child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) })
    })
    let markCancelled!: (value: { cancelled: true }) => void
    const cancelled = new Promise<{ cancelled: true }>((resolve) => { markCancelled = resolve })
    const abort = () => { markCancelled({ cancelled: true }); child.kill('SIGTERM') }
    options.signal.addEventListener('abort', abort, { once: true })
    try {
      options.signal.throwIfAborted()
      const client = new DesktopHostClient({ localPort: inspected.port,
        compatibility: { productVersion: inspected.productVersion, buildCommit: inspected.sourceDigest }, requestTimeoutMs: 1000 })
      const readySignal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
      while (true) {
        readySignal.throwIfAborted()
        if (ended) {
          const result = await closed
          throw result.error ?? new Error(`Desktop Host exited before ready (${result.code ?? result.signal}). Close any existing Pi GUI desktop and check startup output.`)
        }
        try { await client.verifyCompatibility(readySignal); break }
        catch (error) {
          if (!(error instanceof DesktopHostClientError) || error.code !== 'network') throw error
          await delay(250, undefined, { signal: readySignal })
        }
      }
      options.signal.throwIfAborted()
      if (ended) throw new Error('Desktop Host exited during its readiness check.')
      options.onReady(inspected)
      const result = await Promise.race([closed, cancelled])
      if ('cancelled' in result) throw options.signal.reason
      if (result.error) throw result.error
      if (result.code !== 0) throw new Error(`Desktop Host exited (${result.code ?? result.signal}).`)
    } finally {
      options.signal.removeEventListener('abort', abort)
      if (!ended) {
        child.kill('SIGTERM')
        await Promise.race([closed, delay(15_000, undefined, { ref: false })])
        if (!ended) {
          child.kill('SIGKILL')
          await Promise.race([closed, delay(5000, undefined, { ref: false })])
          if (!ended) throw new Error(`Desktop Host process ${child.pid} did not exit; inspect it before restarting.`)
          throw new Error('Desktop Host did not shut down within 15 seconds and required SIGKILL. Check its tasks before restarting.')
        }
      }
    }
  } finally { await lock.close() }
}
