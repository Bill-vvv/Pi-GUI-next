import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  checkPiVersion,
  resolvePiExecutable,
  SUPPORTED_PI_VERSION
} from './pi-executable.ts'

export type PiPackageRootOptions = {
  explicitExecutable?: string
  path?: string
  versionTimeoutMs?: number
}

export type VerifiedPiPackageRoot = Readonly<{
  executablePath: string
  packageRoot: string
  sdkEntryPath: string
}>

const PNPM_SHIM_TARGET_PREFIX = '# cmd-shim-target='

export async function resolvePiPackageRootLayout(
  options: PiPackageRootOptions = {}
): Promise<VerifiedPiPackageRoot> {
  const executable = resolvePiExecutable({
    explicitPath: options.explicitExecutable,
    path: options.path
  })
  const resolvedExecutable = await resolvePiPackageExecutable(executable)
  const packageRoot = dirname(dirname(resolvedExecutable))
  const packageJsonPath = resolve(packageRoot, 'package.json')
  const manifest = parseManifest(await readFile(packageJsonPath, 'utf8'))
  if (manifest.version !== SUPPORTED_PI_VERSION) {
    throw new Error(`Pi package version must be exactly ${SUPPORTED_PI_VERSION}.`)
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

async function resolvePiPackageExecutable(executable: string): Promise<string> {
  const resolvedExecutable = await realpath(executable)
  if (basename(dirname(resolvedExecutable)) !== '.bin') return resolvedExecutable

  const shim = await readFile(resolvedExecutable, 'utf8')
  const targetLine = shim
    .split(/\r?\n/u)
    .find((line) => line.startsWith(PNPM_SHIM_TARGET_PREFIX))
  if (targetLine === undefined) return resolvedExecutable

  const target = targetLine.slice(PNPM_SHIM_TARGET_PREFIX.length)
  if (!isAbsolute(target)) {
    throw new Error('Pi pnpm shim target must be an absolute path.')
  }
  return realpath(target)
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

function parseManifest(raw: string): { version?: unknown, exports?: unknown } {
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

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
