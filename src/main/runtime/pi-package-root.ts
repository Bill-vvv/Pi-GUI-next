import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  checkPiVersion,
  resolvePiExecutable,
  SUPPORTED_PI_VERSION
} from './pi-executable.ts'

const MAX_PI_ENTRY_PROBE_BYTES = 4_096
const PI_ENTRY_PROBE_RESULT_ENV = 'PI_GUI_PI_ENTRY_PROBE_RESULT'
const WINDOWS_COMMAND_SHIM_EXTENSIONS = new Set(['.bat', '.cmd'])
const PI_ENTRY_PROBE_SOURCE = `
import { writeFileSync } from 'node:fs'
const resultPath = process.env.${PI_ENTRY_PROBE_RESULT_ENV}
const entryPath = process.argv[1]
if (typeof resultPath !== 'string' || resultPath.length === 0 || typeof entryPath !== 'string' || entryPath.length === 0) {
  throw new Error('Pi entry probe identity is unavailable.')
}
writeFileSync(resultPath, JSON.stringify({ entryPath }), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
`
const PI_ENTRY_PROBE_IMPORT = `data:text/javascript;base64,${Buffer.from(PI_ENTRY_PROBE_SOURCE).toString('base64')}`

export type PiPackageRootOptions = {
  explicitExecutable?: string
  path?: string
  pathExt?: string
  platform?: NodeJS.Platform
  versionTimeoutMs?: number
}

export type VerifiedPiPackageRoot = Readonly<{
  executablePath: string
  packageRoot: string
  sdkEntryPath: string
}>

export async function resolvePiPackageRootLayout(
  options: PiPackageRootOptions = {}
): Promise<VerifiedPiPackageRoot> {
  const platform = options.platform ?? process.platform
  const executable = resolvePiExecutable({
    explicitPath: options.explicitExecutable,
    path: options.path,
    pathExt: options.pathExt,
    platform
  })
  const resolvedExecutable = await realpath(executable)
  const packageExecutableEntry = await resolvePackageExecutableEntry(resolvedExecutable, platform, options.versionTimeoutMs)
  const packageRoot = dirname(dirname(packageExecutableEntry))
  const packageJsonPath = resolve(packageRoot, 'package.json')
  const manifest = parseManifest(await readFile(packageJsonPath, 'utf8'))
  if (manifest.version !== SUPPORTED_PI_VERSION) {
    throw new Error(`Pi package version must be exactly ${SUPPORTED_PI_VERSION}.`)
  }
  if (isWindowsCommandShim(resolvedExecutable, platform)) {
    await assertManifestPiEntry(packageRoot, packageExecutableEntry, manifest.bin)
  }
  const entryPath = resolve(packageRoot, rootImportTarget(manifest.exports))
  if (!isWithin(packageRoot, entryPath)) {
    throw new Error('Pi package root export resolves outside its package root.')
  }
  const canonicalEntryPath = await realpath(entryPath)
  if (!isWithin(packageRoot, canonicalEntryPath)) {
    throw new Error('Pi package root export resolves outside its package root.')
  }
  return Object.freeze({
    executablePath: resolvedExecutable,
    packageRoot,
    sdkEntryPath: canonicalEntryPath
  })
}

export async function resolveVerifiedPiPackageRoot(
  cwd: string,
  options: PiPackageRootOptions = {}
): Promise<VerifiedPiPackageRoot> {
  const verified = await resolvePiPackageRootLayout(options)
  await checkPiVersion({
    executable: verified.executablePath,
    cwd,
    timeoutMs: options.versionTimeoutMs
  })
  return verified
}

export async function importVerifiedPiPackageRoot(
  cwd: string,
  options: PiPackageRootOptions = {}
): Promise<Record<string, unknown>> {
  const verified = await resolveVerifiedPiPackageRoot(cwd, options)
  const imported: unknown = await import(pathToFileURL(verified.sdkEntryPath).href)
  if (typeof imported !== 'object' || imported === null || Array.isArray(imported)) {
    throw new Error('Pi package root export must be an object.')
  }
  return imported as Record<string, unknown>
}

function parseManifest(raw: string): { version?: unknown, exports?: unknown, bin?: unknown } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Pi package manifest is not valid JSON.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Pi package manifest must be a JSON object.')
  }
  return value
}

function rootImportTarget(exportsValue: unknown): string {
  if (typeof exportsValue !== 'object' || exportsValue === null || Array.isArray(exportsValue)) {
    throw new Error('Pi package does not declare a root export.')
  }
  const root = (exportsValue as Record<string, unknown>)['.']
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('Pi package root export is unavailable.')
  }
  const target = (root as Record<string, unknown>).import
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error('Pi package root import export is unavailable.')
  }
  return target
}

async function resolvePackageExecutableEntry(
  executable: string,
  platform: NodeJS.Platform,
  timeoutMs: number | undefined
): Promise<string> {
  if (!isWindowsCommandShim(executable, platform)) {
    return executable
  }

  const probeDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-pi-entry-'))
  const resultPath = join(probeDirectory, 'entry.json')

  try {
    const nodeOptions = [process.env.NODE_OPTIONS, `--import=${PI_ENTRY_PROBE_IMPORT}`]
      .filter((value) => value !== undefined && value.length > 0)
      .join(' ')
    await checkPiVersion({
      executable,
      cwd: dirname(executable),
      timeoutMs,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        [PI_ENTRY_PROBE_RESULT_ENV]: resultPath
      }
    })

    let resultStats
    try {
      resultStats = await stat(resultPath)
    } catch {
      throw new Error('Pi command shim did not report its package entry path.')
    }
    if (!resultStats.isFile() || resultStats.size > MAX_PI_ENTRY_PROBE_BYTES) {
      throw new Error('Pi command shim reported an invalid package entry result.')
    }

    const entryPath = parseEntryProbeResult(await readFile(resultPath, 'utf8'))
    return await realpath(entryPath)
  } finally {
    await rm(probeDirectory, { force: true, recursive: true })
  }
}

function parseEntryProbeResult(raw: string): string {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('Pi command shim reported malformed package entry data.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Pi command shim reported malformed package entry data.')
  }
  const entryPath = (value as Record<string, unknown>).entryPath
  if (typeof entryPath !== 'string' || !isAbsolute(entryPath) || resolve(entryPath) !== entryPath) {
    throw new Error('Pi command shim reported an invalid package entry path.')
  }
  return entryPath
}

async function assertManifestPiEntry(packageRoot: string, executableEntry: string, binValue: unknown): Promise<void> {
  if (typeof binValue !== 'object' || binValue === null || Array.isArray(binValue)) {
    throw new Error('Pi package does not declare its command entry.')
  }
  const target = (binValue as Record<string, unknown>).pi
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Pi package does not declare its command entry.')
  }
  const declaredEntry = resolve(packageRoot, target)
  if (!isWithin(packageRoot, declaredEntry)) {
    throw new Error('Pi package command entry resolves outside its package root.')
  }
  const canonicalDeclaredEntry = await realpath(declaredEntry)
  if (canonicalDeclaredEntry !== executableEntry) {
    throw new Error('Pi command shim does not resolve to the declared Pi package entry.')
  }
}

function isWindowsCommandShim(executable: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && WINDOWS_COMMAND_SHIM_EXTENSIONS.has(extname(executable).toLowerCase())
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}
