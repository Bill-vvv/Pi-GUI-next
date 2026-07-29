import { createHash } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkPiVersion } from '../runtime/pi-executable.ts'
import {
  type PiPackageRootOptions,
  resolvePiPackageRootLayout
} from '../runtime/pi-package-root.ts'
import {
  CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES,
  CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES,
  CAPABILITY_INVENTORY_LIMITS,
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  type CapabilityInventoryDiagnostic,
  type CapabilityInventoryDiagnosticCode,
  type CapabilityInventoryItemState,
  type CapabilityInventoryOrigin,
  type CapabilityInventoryPackage,
  type CapabilityInventoryResource,
  type CapabilityInventoryResourceKind,
  type CapabilityInventoryScope,
  type CapabilityInventoryScopeRequest,
  type CapabilityInventorySnapshot,
  type CapabilityInventorySourceKind
} from '../../shared/capability-inventory-contract.ts'

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_STDERR_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 120_000
const TERMINATION_GRACE_MS = 250

/**
 * Main-owned input only. This is intentionally not a shared IPC request type.
 * The caller must resolve canonical Project/Task semantics and trust before invoking the service;
 * Renderer-provided filesystem paths must never be passed through as these fields.
 */
export type PiCapabilityInventoryInput = {
  cwd: string
  agentDir: string
  projectTrusted: boolean
  scope: CapabilityInventoryScopeRequest
}

export type PiCapabilityInventoryReadOptions = {
  signal?: AbortSignal
}

export type PiCapabilityInventoryServiceOptions = {
  /** Main-owned Pi lookup only. The exact 0.80.10 package root is reverified before every worker spawn. */
  piPackage?: PiPackageRootOptions
  /** Compiled worker entry. Tests may inject the source worker entry under the current Node runtime. */
  workerPath?: string
  runtimeExecutable?: string
  timeoutMs?: number
}

export class PiCapabilityInventoryService {
  private readonly piPackage: PiPackageRootOptions
  private readonly workerPath: string
  private readonly runtimeExecutable: string
  private readonly timeoutMs: number

  constructor(options: PiCapabilityInventoryServiceOptions = {}) {
    this.piPackage = { ...options.piPackage }
    this.workerPath = options.workerPath ?? fileURLToPath(
      new URL('./pi-capability-inventory-worker.js', import.meta.url)
    )
    assertAbsolutePath(this.workerPath, 'Capability inventory worker')
    this.runtimeExecutable = options.runtimeExecutable ?? process.execPath
    assertAbsolutePath(this.runtimeExecutable, 'Capability inventory runtime')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error('Capability inventory timeout is invalid.')
    }
  }

  async read(
    input: PiCapabilityInventoryInput,
    options: PiCapabilityInventoryReadOptions = {}
  ): Promise<CapabilityInventorySnapshot> {
    validateInput(input)
    if (options.signal?.aborted === true) return workerFailureSnapshot(input, 'INVENTORY_WORKER_ABORTED')

    let piPackage: Awaited<ReturnType<typeof resolvePiPackageRootLayout>>
    try {
      piPackage = await resolvePiPackageRootLayout(this.piPackage)
    } catch {
      return workerFailureSnapshot(input, 'PI_ROOT_IMPORT_FAILED')
    }

    const request = serializeWorkerRequest(input, piPackage.packageRoot)
    if (Buffer.byteLength(request, 'utf8') > CAPABILITY_INVENTORY_LIMITS.requestBytes) {
      throw new Error('Capability inventory request exceeds its transport limit.')
    }
    try {
      await checkPiVersion({
        executable: piPackage.executablePath,
        cwd: input.cwd,
        timeoutMs: this.piPackage.versionTimeoutMs
      })
    } catch {
      return workerFailureSnapshot(input, 'PI_ROOT_IMPORT_FAILED')
    }

    const result = await runWorker({
      executable: this.runtimeExecutable,
      workerPath: this.workerPath,
      cwd: input.cwd,
      request,
      timeoutMs: this.timeoutMs,
      signal: options.signal
    })
    if (result.state === 'timeout') return workerFailureSnapshot(input, 'INVENTORY_WORKER_TIMEOUT')
    if (result.state === 'aborted') return workerFailureSnapshot(input, 'INVENTORY_WORKER_ABORTED')
    if (result.state !== 'complete') return workerFailureSnapshot(input, 'INVENTORY_WORKER_FAILED')

    let envelope: unknown
    try {
      envelope = JSON.parse(result.stdout)
    } catch {
      return workerFailureSnapshot(input, 'INVENTORY_WORKER_FAILED')
    }
    if (!isRecord(envelope) || !hasExactKeys(envelope, ['ok', 'snapshot']) || envelope.ok !== true) {
      if (isRecord(envelope) && envelope.code === 'PI_ROOT_IMPORT_FAILED') {
        return workerFailureSnapshot(input, 'PI_ROOT_IMPORT_FAILED')
      }
      return workerFailureSnapshot(input, 'INVENTORY_WORKER_FAILED')
    }
    const snapshot = copySnapshot(envelope.snapshot, input)
    return snapshot ?? workerFailureSnapshot(input, 'INVENTORY_WORKER_FAILED')
  }
}

function serializeWorkerRequest(input: PiCapabilityInventoryInput, piPackageRoot: string): string {
  return JSON.stringify({
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    piPackageRoot,
    cwd: input.cwd,
    agentDir: input.agentDir,
    projectTrusted: input.projectTrusted,
    scope: input.scope
  })
}

type WorkerResult =
  | { state: 'complete', stdout: string }
  | { state: 'failed' | 'timeout' | 'aborted' }

async function runWorker(options: {
  executable: string
  workerPath: string
  cwd: string
  request: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<WorkerResult> {
  if (options.signal?.aborted === true) return { state: 'aborted' }
  return new Promise((resolveResult) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(options.executable, [options.workerPath], {
        cwd: options.cwd,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: capabilityWorkerEnvironment()
      })
    } catch {
      resolveResult({ state: 'failed' })
      return
    }

    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminalState: 'failed' | 'timeout' | 'aborted' | null = null
    let killTimer: NodeJS.Timeout | null = null
    let terminalFinishTimer: NodeJS.Timeout | null = null

    const finish = (result: WorkerResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (terminalFinishTimer !== null) clearTimeout(terminalFinishTimer)
      options.signal?.removeEventListener('abort', onAbort)
      resolveResult(result)
    }
    const terminate = (state: 'failed' | 'timeout' | 'aborted'): void => {
      if (terminalState !== null || settled) return
      terminalState = state
      clearTimeout(timeoutTimer)
      signalProcessGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => {
        signalProcessGroup(child, 'SIGKILL')
        terminalFinishTimer = setTimeout(() => finish({ state }), 25)
      }, TERMINATION_GRACE_MS)
    }
    const onAbort = (): void => terminate('aborted')

    const timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    // Close the race between the caller's pre-spawn check and listener registration.
    if (options.signal?.aborted === true) terminate('aborted')

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > CAPABILITY_INVENTORY_LIMITS.workerResponseBytes) {
        terminate('failed')
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_STDERR_BYTES) terminate('failed')
      // Stderr is intentionally never returned, logged, or attached to a diagnostic.
    })
    child.on('error', () => terminate('failed'))
    child.on('exit', (code, signal) => {
      if (terminalState === null && code === 0 && signal === null) {
        // Kill ordinary descendants as soon as the successful group leader exits. A descendant
        // that deliberately escapes with setsid(2) remains outside this process-group boundary.
        signalProcessGroup(child, 'SIGKILL')
      }
    })
    child.on('close', (code, signal) => {
      if (terminalState !== null) return
      if (code !== 0 || signal !== null) {
        // A failed worker may already have spawned descendants. Kill its detached Linux group.
        signalProcessGroup(child, 'SIGKILL')
        finish({ state: 'failed' })
        return
      }
      finish({ state: 'complete', stdout: Buffer.concat(stdout).toString('utf8').trim() })
    })
    child.stdin.on('error', () => terminate('failed'))
    child.stdin.end(options.request)
  })
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* The process already exited. */ }
  }
}

function capabilityWorkerEnvironment(): NodeJS.ProcessEnv {
  return {
    PI_OFFLINE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  }
}

function workerFailureSnapshot(
  input: PiCapabilityInventoryInput,
  code: 'INVENTORY_WORKER_FAILED' | 'INVENTORY_WORKER_TIMEOUT' | 'INVENTORY_WORKER_ABORTED' | 'PI_ROOT_IMPORT_FAILED'
): CapabilityInventorySnapshot {
  const message = CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES[code]
  const policy = CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES[code]
  return {
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    inventoryKind: 'static-resolved-not-runtime-effective',
    requestedScope: input.scope,
    projectTrusted: input.projectTrusted,
    resolvedComplete: false,
    resolvedUnavailableReason: 'sdk-error',
    packages: [],
    resources: [],
    diagnostics: [{
      id: `diag_${createHash('sha256').update(`${code}\0${message}`).digest('hex').slice(0, 24)}`,
      code,
      severity: policy.severity,
      kind: policy.kind,
      resourceId: null,
      message,
      collision: null
    }],
    truncated: {
      packages: false,
      resources: false,
      diagnostics: false,
      canonicalEffectiveResources: false
    }
  }
}

function copySnapshot(
  value: unknown,
  request: PiCapabilityInventoryInput
): CapabilityInventorySnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion', 'inventoryKind', 'requestedScope', 'projectTrusted', 'resolvedComplete',
    'resolvedUnavailableReason', 'packages', 'resources', 'diagnostics', 'truncated'
  ]) || value.schemaVersion !== CAPABILITY_INVENTORY_SCHEMA_VERSION ||
    value.inventoryKind !== 'static-resolved-not-runtime-effective' ||
    value.requestedScope !== request.scope || value.projectTrusted !== request.projectTrusted ||
    typeof value.resolvedComplete !== 'boolean' || !isResolvedUnavailableReason(value.resolvedUnavailableReason) ||
    !Array.isArray(value.packages) || value.packages.length > CAPABILITY_INVENTORY_LIMITS.packages ||
    !Array.isArray(value.resources) || value.resources.length > CAPABILITY_INVENTORY_LIMITS.resources ||
    !Array.isArray(value.diagnostics) || value.diagnostics.length > CAPABILITY_INVENTORY_LIMITS.diagnostics ||
    !isRecord(value.truncated) || !hasExactKeys(value.truncated, [
      'packages', 'resources', 'diagnostics', 'canonicalEffectiveResources'
    ])) return null

  const packages: CapabilityInventoryPackage[] = []
  for (const item of value.packages) {
    const copied = copyPackage(item)
    if (copied === null) return null
    packages.push(copied)
  }
  const resources: CapabilityInventoryResource[] = []
  for (const item of value.resources) {
    const copied = copyResource(item)
    if (copied === null) return null
    resources.push(copied)
  }
  const diagnostics: CapabilityInventoryDiagnostic[] = []
  for (const item of value.diagnostics) {
    const copied = copyDiagnostic(item)
    if (copied === null) return null
    diagnostics.push(copied)
  }
  const truncated = value.truncated
  const truncationKeys = ['packages', 'resources', 'diagnostics', 'canonicalEffectiveResources'] as const
  if (!truncationKeys.every((key) => typeof truncated[key] === 'boolean')) return null

  const snapshot: CapabilityInventorySnapshot = {
    schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    inventoryKind: 'static-resolved-not-runtime-effective',
    requestedScope: request.scope,
    projectTrusted: request.projectTrusted,
    resolvedComplete: value.resolvedComplete,
    resolvedUnavailableReason: value.resolvedUnavailableReason,
    packages,
    resources,
    diagnostics,
    truncated: {
      packages: truncated.packages as boolean,
      resources: truncated.resources as boolean,
      diagnostics: truncated.diagnostics as boolean,
      canonicalEffectiveResources: truncated.canonicalEffectiveResources as boolean
    }
  }
  if (!validateSnapshotSemantics(snapshot)) return null
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > CAPABILITY_INVENTORY_LIMITS.serializedSnapshotBytes) {
    return null
  }
  return snapshot
}

function copyPackage(value: unknown): CapabilityInventoryPackage | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'inventoryState', 'scope', 'source', 'sourceKind', 'packageName',
    'requestedVersionOrRef', 'installedVersion', 'installed', 'filtered', 'autoload', 'state',
    'effective', 'resourceCounts', 'resourceCountsTruncated', 'diagnosticIds'
  ]) || !validString(value.id, CAPABILITY_INVENTORY_LIMITS.idBytes) ||
    value.inventoryState !== 'static-declaration' || !isScope(value.scope) ||
    !validString(value.source, CAPABILITY_INVENTORY_LIMITS.sourceBytes) ||
    !isSourceKind(value.sourceKind) || !nullableString(value.packageName, CAPABILITY_INVENTORY_LIMITS.nameBytes) ||
    !nullableString(value.requestedVersionOrRef, CAPABILITY_INVENTORY_LIMITS.versionOrRefBytes) ||
    value.installedVersion !== null || typeof value.installed !== 'boolean' || typeof value.filtered !== 'boolean' ||
    !(value.autoload === null || typeof value.autoload === 'boolean') || !isItemState(value.state) ||
    !(value.effective === null || typeof value.effective === 'boolean') || !isRecord(value.resourceCounts) ||
    !hasExactKeys(value.resourceCounts, ['extensions', 'skills', 'prompts', 'themes']) ||
    typeof value.resourceCountsTruncated !== 'boolean' || !validIdArray(value.diagnosticIds)) return null
  const counts = value.resourceCounts
  if (!validCount(counts.extensions) || !validCount(counts.skills) || !validCount(counts.prompts) ||
    !validCount(counts.themes)) return null
  if (value.sourceKind === 'unknown' && (value.source !== '[redacted-source]' ||
    value.packageName !== null || value.requestedVersionOrRef !== null)) return null
  if ((value.sourceKind === 'git' || value.sourceKind === 'local') && value.packageName !== null) return null
  if (value.sourceKind === 'local' && value.requestedVersionOrRef !== null) return null
  return {
    id: value.id,
    inventoryState: 'static-declaration',
    scope: value.scope,
    source: value.source,
    sourceKind: value.sourceKind,
    packageName: value.packageName as string | null,
    requestedVersionOrRef: value.requestedVersionOrRef as string | null,
    installedVersion: null,
    installed: value.installed,
    filtered: value.filtered,
    autoload: value.autoload as boolean | null,
    state: value.state,
    effective: value.effective as boolean | null,
    resourceCounts: {
      extensions: counts.extensions as number,
      skills: counts.skills as number,
      prompts: counts.prompts as number,
      themes: counts.themes as number
    },
    resourceCountsTruncated: value.resourceCountsTruncated,
    diagnosticIds: [...value.diagnosticIds]
  }
}

function copyResource(value: unknown): CapabilityInventoryResource | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'inventoryState', 'runtimeEffectiveState', 'kind', 'name', 'scope', 'origin',
    'ownerPackageId', 'source', 'displayPath', 'declaredEnabled', 'state', 'modelInvocation', 'diagnosticIds'
  ]) || !validString(value.id, CAPABILITY_INVENTORY_LIMITS.idBytes) ||
    value.inventoryState !== 'static-resolved' || value.runtimeEffectiveState !== 'not-observed' ||
    !isResourceKind(value.kind) || !validString(value.name, CAPABILITY_INVENTORY_LIMITS.nameBytes) ||
    !isScope(value.scope) || !isOrigin(value.origin) ||
    !(value.ownerPackageId === null || validString(value.ownerPackageId, CAPABILITY_INVENTORY_LIMITS.idBytes)) ||
    !validString(value.source, CAPABILITY_INVENTORY_LIMITS.sourceBytes) ||
    !validString(value.displayPath, CAPABILITY_INVENTORY_LIMITS.displayPathBytes) ||
    typeof value.declaredEnabled !== 'boolean' || !isItemState(value.state) ||
    !isModelInvocation(value.modelInvocation) || !validIdArray(value.diagnosticIds)) return null
  return {
    id: value.id,
    inventoryState: 'static-resolved',
    runtimeEffectiveState: 'not-observed',
    kind: value.kind,
    name: value.name,
    scope: value.scope,
    origin: value.origin,
    ownerPackageId: value.ownerPackageId as string | null,
    source: value.source,
    displayPath: value.displayPath,
    declaredEnabled: value.declaredEnabled,
    state: value.state,
    modelInvocation: value.modelInvocation,
    diagnosticIds: [...value.diagnosticIds]
  }
}

function copyDiagnostic(value: unknown): CapabilityInventoryDiagnostic | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'code', 'severity', 'kind', 'resourceId', 'message', 'collision'
  ]) || !validString(value.id, CAPABILITY_INVENTORY_LIMITS.idBytes) ||
    !isDiagnosticCode(value.code) || !(value.severity === 'warning' || value.severity === 'error') ||
    !isDiagnosticKind(value.kind) ||
    !(value.resourceId === null || validString(value.resourceId, CAPABILITY_INVENTORY_LIMITS.idBytes)) ||
    value.message !== CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES[value.code]) return null
  const policy = CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES[value.code]
  if (value.severity !== policy.severity || value.kind !== policy.kind) return null
  let collision: CapabilityInventoryDiagnostic['collision'] = null
  if (value.collision !== null) {
    if (!isRecord(value.collision) || !hasExactKeys(value.collision, [
      'resourceKind', 'name', 'winnerResourceId', 'loserResourceId'
    ]) || !isResourceKind(value.collision.resourceKind) ||
      !validString(value.collision.name, CAPABILITY_INVENTORY_LIMITS.nameBytes) ||
      !(value.collision.winnerResourceId === null || validString(value.collision.winnerResourceId, CAPABILITY_INVENTORY_LIMITS.idBytes)) ||
      !(value.collision.loserResourceId === null || validString(value.collision.loserResourceId, CAPABILITY_INVENTORY_LIMITS.idBytes))) return null
    collision = {
      resourceKind: value.collision.resourceKind,
      name: value.collision.name,
      winnerResourceId: value.collision.winnerResourceId as string | null,
      loserResourceId: value.collision.loserResourceId as string | null
    }
  }
  if ((policy.collision === 'required') !== (collision !== null)) return null
  return {
    id: value.id,
    code: value.code,
    severity: value.severity,
    kind: value.kind,
    resourceId: value.resourceId as string | null,
    message: value.message,
    collision
  }
}

function validateSnapshotSemantics(snapshot: CapabilityInventorySnapshot): boolean {
  const allowedScopes = allowedItemScopes(snapshot.requestedScope, snapshot.projectTrusted)
  if (snapshot.packages.some((pkg) => !allowedScopes.has(pkg.scope)) ||
    snapshot.resources.some((resource) => !allowedScopes.has(resource.scope))) return false

  const projectScopeExcludedCount = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'PROJECT_SCOPE_EXCLUDED'
  ).length
  const projectScopeMustBeExcluded = snapshot.requestedScope !== 'user' && !snapshot.projectTrusted
  if (projectScopeExcludedCount !== (projectScopeMustBeExcluded ? 1 : 0)) return false

  const allIds = new Set<string>()
  for (const value of [...snapshot.packages, ...snapshot.resources, ...snapshot.diagnostics]) {
    if (allIds.has(value.id)) return false
    allIds.add(value.id)
  }
  const packageIds = new Set(snapshot.packages.map((pkg) => pkg.id))
  const resourcesById = new Map(snapshot.resources.map((resource) => [resource.id, resource]))
  const diagnosticIds = new Set(snapshot.diagnostics.map((diagnostic) => diagnostic.id))

  for (const pkg of snapshot.packages) {
    if (hasDuplicates(pkg.diagnosticIds) || pkg.diagnosticIds.some((id) => !diagnosticIds.has(id))) return false
  }
  for (const resource of snapshot.resources) {
    if (resource.ownerPackageId !== null && !packageIds.has(resource.ownerPackageId)) return false
    if (hasDuplicates(resource.diagnosticIds) || resource.diagnosticIds.some((id) => !diagnosticIds.has(id))) return false
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.resourceId !== null && !resourcesById.has(diagnostic.resourceId)) return false
    if (diagnostic.collision !== null) {
      for (const id of [diagnostic.collision.winnerResourceId, diagnostic.collision.loserResourceId]) {
        if (id === null) continue
        const resource = resourcesById.get(id)
        if (resource === undefined || resource.kind !== diagnostic.collision.resourceKind) return false
      }
    }
  }

  const limitHit = snapshot.truncated.packages || snapshot.truncated.resources ||
    snapshot.truncated.diagnostics || snapshot.truncated.canonicalEffectiveResources
  const sdkCodes = new Set<CapabilityInventoryDiagnosticCode>([
    'INVENTORY_WORKER_FAILED', 'INVENTORY_WORKER_TIMEOUT', 'INVENTORY_WORKER_ABORTED',
    'PI_ROOT_IMPORT_FAILED', 'PI_SDK_SHAPE_INVALID', 'SETTINGS_CREATE_FAILED',
    'SETTINGS_LOAD_FAILED', 'PACKAGE_LIST_FAILED', 'PACKAGE_RESOLVE_FAILED',
    'RESOURCE_LOADER_FAILED', 'SDK_RESULT_INVALID', 'RESOURCE_VALIDATION', 'FIELD_INVALID'
  ])
  const expectedReason: CapabilityInventorySnapshot['resolvedUnavailableReason'] = limitHit
    ? 'limit'
    : snapshot.diagnostics.some((diagnostic) => sdkCodes.has(diagnostic.code))
      ? 'sdk-error'
      : snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'PACKAGE_MISSING_OFFLINE')
        ? 'offline-missing-package'
        : null
  if (snapshot.resolvedUnavailableReason !== expectedReason || snapshot.resolvedComplete !== (expectedReason === null)) {
    return false
  }
  if (!isCanonicalOrder(snapshot.packages, comparePackages) ||
    !isCanonicalOrder(snapshot.resources, compareResources) ||
    !isCanonicalOrder(snapshot.diagnostics, compareDiagnostics)) return false
  return true
}

function allowedItemScopes(
  requestedScope: CapabilityInventoryScopeRequest,
  projectTrusted: boolean
): ReadonlySet<CapabilityInventoryScope> {
  if (requestedScope === 'user') return USER_SCOPE_ONLY
  if (!projectTrusted) return requestedScope === 'effective' ? USER_SCOPE_ONLY : NO_ITEM_SCOPES
  return requestedScope === 'project' ? PROJECT_SCOPE_ONLY : USER_AND_PROJECT_SCOPES
}

const NO_ITEM_SCOPES = new Set<CapabilityInventoryScope>()
const USER_SCOPE_ONLY = new Set<CapabilityInventoryScope>(['user'])
const PROJECT_SCOPE_ONLY = new Set<CapabilityInventoryScope>(['project'])
const USER_AND_PROJECT_SCOPES = new Set<CapabilityInventoryScope>(['user', 'project'])

function comparePackages(a: CapabilityInventoryPackage, b: CapabilityInventoryPackage): number {
  return scopeOrder(a.scope) - scopeOrder(b.scope) || compareOrdinal(a.source, b.source) || compareOrdinal(a.id, b.id)
}

function compareResources(a: CapabilityInventoryResource, b: CapabilityInventoryResource): number {
  return resourceKindOrder(a.kind) - resourceKindOrder(b.kind) || compareOrdinal(a.name, b.name) ||
    scopeOrder(a.scope) - scopeOrder(b.scope) || compareOrdinal(a.id, b.id)
}

function compareDiagnostics(a: CapabilityInventoryDiagnostic, b: CapabilityInventoryDiagnostic): number {
  return compareOrdinal(a.code, b.code) || compareOrdinal(a.id, b.id)
}

function isCanonicalOrder<T>(values: T[], compare: (a: T, b: T) => number): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1]!, values[index]!) > 0) return false
  }
  return true
}

function scopeOrder(scope: CapabilityInventoryScope): number { return scope === 'user' ? 0 : 1 }
function resourceKindOrder(kind: CapabilityInventoryResourceKind): number {
  return kind === 'extension' ? 0 : kind === 'skill' ? 1 : kind === 'prompt' ? 2 : 3
}
function compareOrdinal(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function hasDuplicates(values: string[]): boolean { return new Set(values).size !== values.length }

function validateInput(input: PiCapabilityInventoryInput): void {
  assertAbsolutePath(input.cwd, 'Capability inventory cwd')
  assertAbsolutePath(input.agentDir, 'Capability inventory agent directory')
  if (typeof input.projectTrusted !== 'boolean') throw new Error('Capability inventory trust decision is invalid.')
  if (!isScopeRequest(input.scope)) throw new Error('Capability inventory scope is invalid.')
}

function assertAbsolutePath(value: string, label: string): void {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 16_384 || /[\u0000\r\n]/u.test(value) || hasLoneSurrogate(value)) {
    throw new Error(`${label} is invalid.`)
  }
}

function validString(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\u0000\r\n]/u.test(value) &&
    !hasLoneSurrogate(value) && Buffer.byteLength(value, 'utf8') <= maximumBytes
}

function nullableString(value: unknown, maximumBytes: number): value is string | null {
  return value === null || validString(value, maximumBytes)
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= CAPABILITY_INVENTORY_LIMITS.resources
}

function validIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= CAPABILITY_INVENTORY_LIMITS.diagnosticIdsPerResource &&
    value.every((item) => validString(item, CAPABILITY_INVENTORY_LIMITS.idBytes))
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareOrdinal)
  const sortedExpected = [...expected].sort(compareOrdinal)
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index])
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScopeRequest(value: unknown): value is CapabilityInventoryScopeRequest {
  return value === 'user' || value === 'project' || value === 'effective'
}

function isScope(value: unknown): value is CapabilityInventoryScope {
  return value === 'user' || value === 'project'
}

function isOrigin(value: unknown): value is CapabilityInventoryOrigin {
  return value === 'package' || value === 'top-level'
}

function isResourceKind(value: unknown): value is CapabilityInventoryResourceKind {
  return value === 'extension' || value === 'skill' || value === 'prompt' || value === 'theme'
}

function isSourceKind(value: unknown): value is CapabilityInventorySourceKind {
  return value === 'npm' || value === 'git' || value === 'local' || value === 'unknown'
}

function isItemState(value: unknown): value is CapabilityInventoryItemState {
  return value === 'declared' || value === 'inherited' || value === 'project-override' ||
    value === 'project-delta' || value === 'disabled' || value === 'unknown' || value === 'error'
}

function isModelInvocation(value: unknown): value is CapabilityInventoryResource['modelInvocation'] {
  return value === 'allowed' || value === 'explicit-only' || value === 'not-applicable' || value === 'unknown'
}

function isDiagnosticKind(value: unknown): value is CapabilityInventoryDiagnostic['kind'] {
  return value === 'validation' || value === 'missing' || value === 'collision' ||
    value === 'load' || value === 'inventory'
}

function isResolvedUnavailableReason(value: unknown): value is CapabilityInventorySnapshot['resolvedUnavailableReason'] {
  return value === null || value === 'offline-missing-package' || value === 'sdk-error' || value === 'limit'
}

function isDiagnosticCode(value: unknown): value is CapabilityInventoryDiagnosticCode {
  return typeof value === 'string' && DIAGNOSTIC_CODES.has(value as CapabilityInventoryDiagnosticCode)
}

const DIAGNOSTIC_CODES = new Set<CapabilityInventoryDiagnosticCode>(Object.keys(
  CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES
) as CapabilityInventoryDiagnosticCode[])
