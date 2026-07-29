import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CAPABILITY_INVENTORY_LIMITS,
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  type CapabilityInventoryScopeRequest
} from '../../shared/capability-inventory-contract.ts'
import {
  createCapabilityInventorySnapshot,
  type CapabilityInventoryWorkerInput
} from './pi-capability-inventory-core.ts'

const SUPPORTED_PI_NAME = '@earendil-works/pi-coding-agent'
const SUPPORTED_PI_VERSION = '0.80.10'
const MAX_MANIFEST_BYTES = 64 * 1024

type WorkerRequest = CapabilityInventoryWorkerInput & {
  schemaVersion: 1
  piPackageRoot: string
}

type WorkerErrorCode = 'INVALID_REQUEST' | 'OFFLINE_GUARD_MISSING' | 'PI_ROOT_IMPORT_FAILED' | 'WORKER_FAILED'

async function main(): Promise<void> {
  let request: WorkerRequest | null = null
  try {
    request = parseRequest(await readSingleRequest())
  } catch {
    request = null
  }
  if (request === null) {
    writeResponse({ ok: false, code: 'INVALID_REQUEST', message: 'Capability inventory worker request was invalid.' })
    return
  }
  if (!isOfflineEnvironment(process.env.PI_OFFLINE)) {
    writeResponse({ ok: false, code: 'OFFLINE_GUARD_MISSING', message: 'Capability inventory worker offline guard was unavailable.' })
    return
  }

  let root: unknown
  try {
    root = await importConfiguredPiPackageRoot(request.piPackageRoot)
  } catch {
    writeResponse({ ok: false, code: 'PI_ROOT_IMPORT_FAILED', message: 'The configured Pi package root could not be imported.' })
    return
  }

  try {
    const snapshot = await createCapabilityInventorySnapshot(root, {
      cwd: request.cwd,
      agentDir: request.agentDir,
      projectTrusted: request.projectTrusted,
      scope: request.scope
    })
    writeResponse({ ok: true, snapshot })
  } catch {
    writeResponse({ ok: false, code: 'WORKER_FAILED', message: 'Capability inventory worker failed.' })
  }
}

async function readSingleRequest(): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > CAPABILITY_INVENTORY_LIMITS.requestBytes) throw new Error('request too large')
    chunks.push(bytes)
  }
  return decodeUtf8Fatal(Buffer.concat(chunks))
}

function parseRequest(raw: string): WorkerRequest | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort(compareOrdinal)
  const expected = ['agentDir', 'cwd', 'piPackageRoot', 'projectTrusted', 'schemaVersion', 'scope'].sort(compareOrdinal)
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null
  if (value.schemaVersion !== CAPABILITY_INVENTORY_SCHEMA_VERSION || typeof value.projectTrusted !== 'boolean') return null
  if (!isScopeRequest(value.scope)) return null
  if (!isBoundedAbsolutePath(value.cwd) || !isBoundedAbsolutePath(value.agentDir) ||
    !isBoundedAbsolutePath(value.piPackageRoot)) return null
  return value as WorkerRequest
}

async function importConfiguredPiPackageRoot(packageRootInput: string): Promise<unknown> {
  const packageRoot = await realpath(packageRootInput)
  const manifestPath = await realpath(resolve(packageRoot, 'package.json'))
  if (!isWithin(packageRoot, manifestPath)) throw new Error('manifest escaped package root')
  const manifestBytes = await readFile(manifestPath)
  if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('invalid manifest size')
  const manifestText = decodeUtf8Fatal(manifestBytes)
  const manifest: unknown = JSON.parse(manifestText)
  if (!isRecord(manifest) || manifest.name !== SUPPORTED_PI_NAME ||
    manifest.version !== SUPPORTED_PI_VERSION || !isRecord(manifest.exports)) {
    throw new Error('invalid manifest')
  }
  const rootExport = manifest.exports['.']
  if (!isRecord(rootExport) || typeof rootExport.import !== 'string' ||
    !rootExport.import.startsWith('./') || /[\u0000\r\n]/u.test(rootExport.import) ||
    hasLoneSurrogate(rootExport.import)) throw new Error('invalid root export')
  const entry = await realpath(resolve(packageRoot, rootExport.import))
  if (!isWithin(packageRoot, entry)) throw new Error('root export escaped package root')
  const imported: unknown = await import(pathToFileURL(entry).href)
  if (!isRecord(imported)) throw new Error('invalid root module')
  return imported
}

function writeResponse(value: { ok: true, snapshot: unknown } | {
  ok: false
  code: WorkerErrorCode
  message: string
}): void {
  let serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > CAPABILITY_INVENTORY_LIMITS.workerResponseBytes) {
    serialized = JSON.stringify({
      ok: false,
      code: 'WORKER_FAILED',
      message: 'Capability inventory worker failed.'
    })
  }
  process.stdout.write(`${serialized}\n`)
}

function decodeUtf8Fatal(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value)
}

function isOfflineEnvironment(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function isBoundedAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 16_384 && !/[\u0000\r\n]/u.test(value) && !hasLoneSurrogate(value)
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function compareOrdinal(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

function isScopeRequest(value: unknown): value is CapabilityInventoryScopeRequest {
  return value === 'user' || value === 'project' || value === 'effective'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

await main().catch(() => {
  writeResponse({ ok: false, code: 'WORKER_FAILED', message: 'Capability inventory worker failed.' })
})
