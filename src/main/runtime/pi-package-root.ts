import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
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

export async function importVerifiedPiPackageRoot(
  cwd: string,
  options: PiPackageRootOptions = {}
): Promise<Record<string, unknown>> {
  const executable = resolvePiExecutable({
    explicitPath: options.explicitExecutable,
    path: options.path
  })
  await checkPiVersion({ executable, cwd, timeoutMs: options.versionTimeoutMs })
  const resolvedExecutable = await realpath(executable)
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
  const imported: unknown = await import(pathToFileURL(canonicalEntryPath).href)
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
  return candidate === root || candidate.startsWith(`${root}/`)
}
