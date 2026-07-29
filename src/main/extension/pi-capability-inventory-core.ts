import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

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

export type CapabilityInventoryWorkerInput = {
  cwd: string
  agentDir: string
  projectTrusted: boolean
  scope: CapabilityInventoryScopeRequest
}

type PiSettingsManager = {
  getGlobalSettings(): unknown
  getProjectSettings(): unknown
  isProjectTrusted(): boolean
  reload(): Promise<void>
  drainErrors(): unknown
  getNpmCommand?: () => string[] | undefined
  [key: PropertyKey]: unknown
}

type PiPackageManager = {
  listConfiguredPackages(): unknown
  resolve(onMissing?: (source: string) => Promise<'install' | 'skip' | 'error'>): Promise<unknown>
}

type PiResourceLoader = {
  reload(): Promise<void>
  getSkills(): unknown
  getPrompts(): unknown
  getThemes(): unknown
}

type PiInventoryRoot = {
  SettingsManager: {
    create(cwd: string, agentDir: string, options: { projectTrusted: boolean }): PiSettingsManager
  }
  DefaultPackageManager: new (options: {
    cwd: string
    agentDir: string
    settingsManager: PiSettingsManager
  }) => PiPackageManager
  DefaultResourceLoader: new (options: {
    cwd: string
    agentDir: string
    settingsManager: PiSettingsManager
    noExtensions: true
    noContextFiles: true
    systemPrompt: ''
    appendSystemPrompt: []
  }) => PiResourceLoader
}

type PackageSourceDescription = {
  source: string
  kind: CapabilityInventorySourceKind
  packageName: string | null
  requestedVersionOrRef: string | null
  identity: string | null
  valid: boolean
}

type RawPackageDeclaration = {
  source: string
  sourceKind: CapabilityInventorySourceKind
  packageName: string | null
  requestedVersionOrRef: string | null
  scope: CapabilityInventoryScope
  filtered: boolean
  installed: boolean
  autoload: boolean | null
  rawSource: string
  identity: string | null
  id: string
  effective: boolean | null
  state: CapabilityInventoryItemState
}

type RawResolvedResource = {
  path: string
  enabled: boolean
  source: string
  scope: CapabilityInventoryScope
  origin: CapabilityInventoryOrigin
  baseDir: string | null
}

type ResourceCandidate = {
  key: string
  rawPath: string
  kind: CapabilityInventoryResourceKind
  name: string
  scope: CapabilityInventoryScope
  origin: CapabilityInventoryOrigin
  rawSource: string
  baseDir: string | null
  enabled: boolean
  modelInvocation: CapabilityInventoryResource['modelInvocation']
  ownerPackageId: string | null
  state: CapabilityInventoryItemState
  forceError: boolean
}

type DiagnosticCandidate = {
  key: string
  code: CapabilityInventoryDiagnosticCode
  severity: 'warning' | 'error'
  kind: CapabilityInventoryDiagnostic['kind']
  resourceKind?: CapabilityInventoryResourceKind
  resourcePath?: string
  packageId?: string
  collision?: {
    resourceKind: CapabilityInventoryResourceKind
    name: string
    winnerPath: string | null
    loserPath: string | null
  }
}

type LoadedCollection = {
  items: unknown[]
  diagnostics: unknown[]
}

type ParsedLoadedResource =
  | { state: 'included', candidate: ResourceCandidate }
  | { state: 'excluded' }
  | { state: 'invalid' }

const MAX_INTERNAL_PACKAGES = CAPABILITY_INVENTORY_LIMITS.packages * 8
const MAX_INTERNAL_RESOURCES = CAPABILITY_INVENTORY_LIMITS.resources * 2
const MAX_INTERNAL_DIAGNOSTICS = CAPABILITY_INVENTORY_LIMITS.diagnostics * 2
const SOURCE_SCOPE_ORDER: Record<CapabilityInventoryScope, number> = { user: 0, project: 1 }
const RESOURCE_KIND_ORDER: Record<CapabilityInventoryResourceKind, number> = {
  extension: 0,
  skill: 1,
  prompt: 2,
  theme: 3
}
const NO_CONFIGURED_COMMAND_ERROR = 'Configured package-manager command execution is disabled for capability inventory.'
const SAFE_NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const SAFE_VERSION_OR_REF = /^[A-Za-z0-9][A-Za-z0-9._+~^*<>=|-]*$/u
const SAFE_GIT_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u
const SAFE_GIT_PATH = /^[A-Za-z0-9._~/-]+$/u

class CompletenessAccumulator {
  private limit = false
  private sdkError = false
  private offlineMissing = false

  markLimit(): void { this.limit = true }
  markSdkError(): void { this.sdkError = true }
  markOfflineMissing(): void { this.offlineMissing = true }
  hasLimit(): boolean { return this.limit }

  reason(): CapabilityInventorySnapshot['resolvedUnavailableReason'] {
    if (this.limit) return 'limit'
    if (this.sdkError) return 'sdk-error'
    if (this.offlineMissing) return 'offline-missing-package'
    return null
  }
}

export async function createCapabilityInventorySnapshot(
  importedRoot: unknown,
  input: CapabilityInventoryWorkerInput
): Promise<CapabilityInventorySnapshot> {
  const diagnostics: DiagnosticCandidate[] = []
  const truncation: CapabilityInventorySnapshot['truncated'] = {
    packages: false,
    resources: false,
    diagnostics: false,
    canonicalEffectiveResources: false
  }
  const completeness = new CompletenessAccumulator()

  const root = parsePiInventoryRoot(importedRoot)
  if (root === null) {
    completeness.markSdkError()
    diagnostics.push(fixedDiagnostic('PI_SDK_SHAPE_INVALID', 'error', 'inventory'))
    return finalizeSnapshot(input, [], [], diagnostics, truncation, completeness)
  }

  const scanProjectTrusted = input.scope === 'user' ? false : input.projectTrusted
  let rawSettingsManager: PiSettingsManager
  try {
    rawSettingsManager = root.SettingsManager.create(input.cwd, input.agentDir, {
      projectTrusted: scanProjectTrusted
    })
  } catch {
    completeness.markSdkError()
    diagnostics.push(fixedDiagnostic('SETTINGS_CREATE_FAILED', 'error', 'inventory'))
    return finalizeSnapshot(input, [], [], diagnostics, truncation, completeness)
  }

  // Both Pi package-manager instances receive this binding-safe proxy. The only configurable
  // command path used by Pi 0.80.10's package manager is getNpmCommand(); throwing here makes
  // legacy global npm discovery fail closed without executing an absolute configured command.
  const settingsManager = createNoExecSettingsManager(rawSettingsManager)
  collectSettingsErrors(settingsManager, input, diagnostics, truncation, completeness)
  const rawSettings = readSettingsDeclarations(settingsManager, input, diagnostics, truncation, completeness)

  let packageManager: PiPackageManager
  try {
    packageManager = new root.DefaultPackageManager({
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager
    })
  } catch {
    completeness.markSdkError()
    diagnostics.push(fixedDiagnostic('PI_SDK_SHAPE_INVALID', 'error', 'inventory'))
    return finalizeSnapshot(input, [], [], diagnostics, truncation, completeness)
  }

  let packageDeclarations: RawPackageDeclaration[] = []
  try {
    packageDeclarations = parseConfiguredPackages(
      packageManager.listConfiguredPackages(),
      rawSettings,
      input,
      diagnostics,
      truncation,
      completeness
    )
  } catch {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('PACKAGE_LIST_FAILED', 'error', 'inventory'), truncation, completeness)
  }

  for (const pkg of packageDeclarations) {
    if (pkg.installed) continue
    completeness.markOfflineMissing()
    pushDiagnostic(diagnostics, {
      ...fixedDiagnostic('PACKAGE_MISSING_OFFLINE', 'warning', 'missing'),
      key: diagnosticKey('PACKAGE_MISSING_OFFLINE', pkg.id, ''),
      packageId: pkg.id
    }, truncation, completeness)
  }

  let resolvedResources: Record<CapabilityInventoryResourceKind, RawResolvedResource[]> = {
    extension: [], skill: [], prompt: [], theme: []
  }
  try {
    // This explicit callback is retained even with PI_OFFLINE: no read call may admit installation.
    const resolvedValue = await packageManager.resolve(async () => 'skip')
    resolvedResources = parseResolvedPaths(
      resolvedValue,
      input,
      diagnostics,
      truncation,
      completeness
    )
  } catch {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('PACKAGE_RESOLVE_FAILED', 'error', 'inventory'), truncation, completeness)
  }

  let loadedSkills: LoadedCollection = { items: [], diagnostics: [] }
  let loadedPrompts: LoadedCollection = { items: [], diagnostics: [] }
  let loadedThemes: LoadedCollection = { items: [], diagnostics: [] }
  try {
    const loader = new root.DefaultResourceLoader({
      cwd: input.cwd,
      agentDir: input.agentDir,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      systemPrompt: '',
      appendSystemPrompt: []
    })
    await loader.reload()
    collectSettingsErrors(settingsManager, input, diagnostics, truncation, completeness)
    loadedSkills = parseLoadedCollection(loader.getSkills(), 'skill', diagnostics, truncation, completeness)
    loadedPrompts = parseLoadedCollection(loader.getPrompts(), 'prompt', diagnostics, truncation, completeness)
    loadedThemes = parseLoadedCollection(loader.getThemes(), 'theme', diagnostics, truncation, completeness)
  } catch {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('RESOURCE_LOADER_FAILED', 'error', 'load'), truncation, completeness)
  }

  const resourceCandidates = buildResourceCandidates({
    input,
    packages: packageDeclarations,
    resolved: resolvedResources,
    loadedSkills,
    loadedPrompts,
    loadedThemes,
    diagnostics,
    truncation,
    completeness
  })

  if (resourceCandidates.length > CAPABILITY_INVENTORY_LIMITS.resources) {
    truncation.canonicalEffectiveResources = true
    truncation.resources = true
    completeness.markLimit()
  }

  if (input.scope !== 'user' && !input.projectTrusted) {
    pushDiagnostic(
      diagnostics,
      fixedDiagnostic('PROJECT_SCOPE_EXCLUDED', 'warning', 'inventory'),
      truncation,
      completeness
    )
  }

  syncLimits(truncation, completeness)
  return finalizeSnapshot(
    input,
    packageDeclarations,
    resourceCandidates,
    diagnostics,
    truncation,
    completeness
  )
}

/** Test-exported only as a narrow proof of the no-exec, binding-safe SettingsManager boundary. */
export function createNoExecSettingsManager<T extends PiSettingsManager>(target: T): T {
  const boundMethods = new Map<PropertyKey, unknown>()
  return new Proxy(target, {
    get(object, property): unknown {
      if (property === 'getNpmCommand') {
        return (): never => { throw new Error(NO_CONFIGURED_COMMAND_ERROR) }
      }
      const value = Reflect.get(object, property, object)
      if (typeof value !== 'function') return value
      if (!boundMethods.has(property)) boundMethods.set(property, value.bind(object))
      return boundMethods.get(property)
    },
    set(object, property, value): boolean {
      return Reflect.set(object, property, value, object)
    }
  })
}

function parsePiInventoryRoot(value: unknown): PiInventoryRoot | null {
  if (!isRecord(value)) return null
  const settingsManager = value.SettingsManager
  if (typeof settingsManager !== 'function' && !isRecord(settingsManager)) return null
  if (typeof (settingsManager as { create?: unknown }).create !== 'function') return null
  if (typeof value.DefaultPackageManager !== 'function') return null
  if (typeof value.DefaultResourceLoader !== 'function') return null
  return value as unknown as PiInventoryRoot
}

function collectSettingsErrors(
  settingsManager: PiSettingsManager,
  input: CapabilityInventoryWorkerInput,
  diagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): void {
  let errors: unknown
  try {
    errors = settingsManager.drainErrors()
  } catch {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('SETTINGS_LOAD_FAILED', 'error', 'validation'), truncation, completeness)
    return
  }
  if (!Array.isArray(errors)) {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
    return
  }
  for (const item of errors) {
    const scope = settingsErrorScope(item)
    if (scope !== null && !scopeIncluded(input.scope, scope)) continue
    if (scope === 'project' && !input.projectTrusted) continue
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('SETTINGS_LOAD_FAILED', 'error', 'validation'), truncation, completeness)
  }
}

function settingsErrorScope(value: unknown): CapabilityInventoryScope | null {
  if (!isRecord(value)) return null
  if (value.scope === 'project') return 'project'
  if (value.scope === 'global' || value.scope === 'user') return 'user'
  return null
}

function readSettingsDeclarations(
  settingsManager: PiSettingsManager,
  input: CapabilityInventoryWorkerInput,
  diagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): Record<CapabilityInventoryScope, unknown[]> {
  const result: Record<CapabilityInventoryScope, unknown[]> = { user: [], project: [] }
  for (const [scope, getter] of [
    ['user', () => settingsManager.getGlobalSettings()],
    ['project', () => settingsManager.getProjectSettings()]
  ] as const) {
    if (!scopeIncluded(input.scope, scope)) continue
    if (scope === 'project' && !input.projectTrusted) continue
    let settings: unknown
    try {
      settings = getter()
    } catch {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SETTINGS_LOAD_FAILED', 'error', 'validation'), truncation, completeness)
      continue
    }
    if (!isRecord(settings)) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }
    if (settings.packages === undefined) continue
    if (!Array.isArray(settings.packages)) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }
    result[scope] = settings.packages
  }
  return result
}

function parseConfiguredPackages(
  value: unknown,
  rawSettings: Record<CapabilityInventoryScope, unknown[]>,
  input: CapabilityInventoryWorkerInput,
  diagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): RawPackageDeclaration[] {
  if (!Array.isArray(value)) throw new Error('invalid package result')
  const packages: RawPackageDeclaration[] = []
  let includedCount = 0
  for (const item of value) {
    const knownScope = isRecord(item) && isScope(item.scope) ? item.scope : null
    if (knownScope !== null && !scopeIncluded(input.scope, knownScope)) continue
    if (knownScope === 'project' && !input.projectTrusted) continue
    if (!isRecord(item) || knownScope === null || typeof item.source !== 'string' ||
      typeof item.filtered !== 'boolean') {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }
    includedCount += 1
    if (includedCount > CAPABILITY_INVENTORY_LIMITS.packages) {
      truncation.packages = true
      completeness.markLimit()
    }
    if (packages.length >= MAX_INTERNAL_PACKAGES) continue

    const rawSource = boundedInternalString(item.source, CAPABILITY_INVENTORY_LIMITS.sourceBytes)
    if (rawSource === null) {
      completeness.markLimit()
      truncation.packages = true
      pushDiagnostic(diagnostics, fixedDiagnostic('FIELD_INVALID', 'error', 'validation'), truncation, completeness)
      continue
    }
    const description = describePackageSource(rawSource, knownScope, input)
    const id = stableId('pkg', `${knownScope}\0${rawSource}`)
    if (!description.valid) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, {
        ...fixedDiagnostic('FIELD_INVALID', 'error', 'validation'),
        key: diagnosticKey('FIELD_INVALID', id, ''),
        packageId: id
      }, truncation, completeness)
    }
    let installed = false
    if (item.installedPath !== undefined) {
      if (typeof item.installedPath !== 'string' || normalizePathString(item.installedPath) === null) {
        completeness.markSdkError()
        pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      } else {
        installed = item.installedPath.length > 0
      }
    }
    const rawEntry = findRawPackageEntry(rawSettings[knownScope], rawSource)
    packages.push({
      source: description.source,
      sourceKind: description.kind,
      packageName: description.packageName,
      requestedVersionOrRef: description.requestedVersionOrRef,
      rawSource,
      scope: knownScope,
      filtered: item.filtered,
      installed,
      autoload: readAutoload(rawEntry, rawSource),
      identity: description.identity,
      id,
      effective: null,
      state: description.valid ? 'declared' : 'error'
    })
  }
  annotatePackageResolution(packages, input.scope)
  return packages
}

function findRawPackageEntry(entries: unknown[], source: string): unknown {
  return entries.find((entry) => entry === source || (isRecord(entry) && entry.source === source))
}

function readAutoload(rawEntry: unknown, source: string): boolean | null {
  if (typeof rawEntry === 'string') return rawEntry === source ? null : null
  if (!isRecord(rawEntry) || rawEntry.source !== source) return null
  return typeof rawEntry.autoload === 'boolean' ? rawEntry.autoload : null
}

function annotatePackageResolution(
  packages: RawPackageDeclaration[],
  requestedScope: CapabilityInventoryScopeRequest
): void {
  if (requestedScope !== 'effective') {
    for (const pkg of packages) {
      pkg.effective = true
      if (pkg.state !== 'error') pkg.state = 'declared'
    }
    return
  }
  const projectByIdentity = new Map<string, RawPackageDeclaration>()
  const userByIdentity = new Map<string, RawPackageDeclaration>()
  for (const pkg of packages) {
    if (pkg.identity === null) continue
    if (pkg.scope === 'project') projectByIdentity.set(pkg.identity, pkg)
    else userByIdentity.set(pkg.identity, pkg)
  }
  for (const pkg of packages) {
    if (pkg.state === 'error') {
      pkg.effective = null
      continue
    }
    if (pkg.scope === 'user') {
      const project = pkg.identity === null ? undefined : projectByIdentity.get(pkg.identity)
      pkg.effective = project === undefined || project.autoload === false
      pkg.state = pkg.effective ? 'inherited' : 'declared'
      continue
    }
    const hasUserBase = pkg.identity !== null && userByIdentity.has(pkg.identity)
    pkg.effective = true
    pkg.state = hasUserBase
      ? pkg.autoload === false ? 'project-delta' : 'project-override'
      : 'declared'
  }
}

function parseResolvedPaths(
  value: unknown,
  input: CapabilityInventoryWorkerInput,
  diagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): Record<CapabilityInventoryResourceKind, RawResolvedResource[]> {
  const result: Record<CapabilityInventoryResourceKind, RawResolvedResource[]> = {
    extension: [], skill: [], prompt: [], theme: []
  }
  if (!isRecord(value)) {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
    return result
  }
  for (const [field, kind] of [
    ['extensions', 'extension'],
    ['skills', 'skill'],
    ['prompts', 'prompt'],
    ['themes', 'theme']
  ] as const) {
    const entries = value[field]
    if (!Array.isArray(entries)) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }
    let includedCount = 0
    for (const entry of entries) {
      const knownScope = isRecord(entry) && isRecord(entry.metadata) && isScope(entry.metadata.scope)
        ? entry.metadata.scope
        : null
      if (knownScope !== null && !scopeIncluded(input.scope, knownScope)) continue
      if (knownScope === 'project' && !input.projectTrusted) continue
      const parsed = parseResolvedResource(entry)
      if (parsed === null) {
        completeness.markSdkError()
        pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
        continue
      }
      includedCount += 1
      if (includedCount > CAPABILITY_INVENTORY_LIMITS.resources) {
        truncation.canonicalEffectiveResources = true
        completeness.markLimit()
      }
      if (result[kind].length >= MAX_INTERNAL_RESOURCES) continue
      result[kind].push(parsed)
    }
  }
  return result
}

function parseResolvedResource(value: unknown): RawResolvedResource | null {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.enabled !== 'boolean' ||
    !isRecord(value.metadata)) return null
  const metadata = value.metadata
  if (typeof metadata.source !== 'string' || !isScope(metadata.scope) || !isOrigin(metadata.origin)) return null
  const path = normalizePathString(value.path)
  const source = boundedInternalString(metadata.source, CAPABILITY_INVENTORY_LIMITS.sourceBytes)
  if (path === null || source === null) return null
  let baseDir: string | null = null
  if (metadata.baseDir !== undefined) {
    if (typeof metadata.baseDir !== 'string') return null
    baseDir = normalizePathString(metadata.baseDir)
    if (baseDir === null) return null
  }
  return { path, enabled: value.enabled, source, scope: metadata.scope, origin: metadata.origin, baseDir }
}

function parseLoadedCollection(
  value: unknown,
  kind: Exclude<CapabilityInventoryResourceKind, 'extension'>,
  diagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): LoadedCollection {
  const itemField = kind === 'skill' ? 'skills' : kind === 'prompt' ? 'prompts' : 'themes'
  if (!isRecord(value) || !Array.isArray(value[itemField]) || !Array.isArray(value.diagnostics)) {
    completeness.markSdkError()
    pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
    return { items: [], diagnostics: [] }
  }
  return { items: value[itemField], diagnostics: value.diagnostics }
}

function buildResourceCandidates(options: {
  input: CapabilityInventoryWorkerInput
  packages: RawPackageDeclaration[]
  resolved: Record<CapabilityInventoryResourceKind, RawResolvedResource[]>
  loadedSkills: LoadedCollection
  loadedPrompts: LoadedCollection
  loadedThemes: LoadedCollection
  diagnostics: DiagnosticCandidate[]
  truncation: CapabilityInventorySnapshot['truncated']
  completeness: CompletenessAccumulator
}): ResourceCandidate[] {
  const { input, packages, resolved, diagnostics, truncation, completeness } = options
  const candidates = new Map<string, ResourceCandidate>()
  const packageBySource = new Map(packages.map((pkg) => [`${pkg.scope}\0${pkg.rawSource}`, pkg]))

  const add = (candidate: ResourceCandidate): void => {
    if (!scopeIncluded(input.scope, candidate.scope)) return
    if (candidate.scope === 'project' && !input.projectTrusted) return
    if (candidates.has(candidate.key)) return
    if (candidates.size >= MAX_INTERNAL_RESOURCES) {
      truncation.resources = true
      completeness.markLimit()
      return
    }
    candidates.set(candidate.key, candidate)
  }

  for (const entry of resolved.extension) {
    add(resourceFromResolved('extension', entry, input, packageBySource, completeness))
  }

  const parsedByKind: Record<Exclude<CapabilityInventoryResourceKind, 'extension'>, LoadedCollection> = {
    skill: options.loadedSkills,
    prompt: options.loadedPrompts,
    theme: options.loadedThemes
  }

  for (const kind of ['skill', 'prompt', 'theme'] as const) {
    const parsedPaths = new Set<string>()
    for (const item of parsedByKind[kind].items) {
      const parsed = resourceFromLoaded(kind, item, resolved[kind], input, packageBySource, completeness)
      if (parsed.state === 'excluded') continue
      if (parsed.state === 'invalid') {
        completeness.markSdkError()
        pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
        continue
      }
      parsedPaths.add(parsed.candidate.rawPath)
      add(parsed.candidate)
    }
    for (const entry of resolved[kind]) {
      const represented = [...parsedPaths].some((path) => isPathAtOrBelow(path, entry.path))
      if (!entry.enabled || !represented) {
        add(resourceFromResolved(kind, entry, input, packageBySource, completeness))
      }
    }
    collectResourceDiagnostics(
      kind,
      parsedByKind[kind].diagnostics,
      candidates,
      resolved[kind],
      input,
      packageBySource,
      diagnostics,
      truncation,
      completeness,
      add
    )
  }

  return [...candidates.values()]
}

function resourceFromResolved(
  kind: CapabilityInventoryResourceKind,
  entry: RawResolvedResource,
  input: CapabilityInventoryWorkerInput,
  packageBySource: Map<string, RawPackageDeclaration>,
  completeness: CompletenessAccumulator
): ResourceCandidate {
  const owner = entry.origin === 'package'
    ? packageBySource.get(`${entry.scope}\0${entry.source}`) ?? null
    : null
  const name = fallbackResourceName(entry.path, kind, entry.scope, entry.origin, entry.baseDir, input)
  if (!describeResourceSource(entry.source, entry.scope, input).valid) completeness.markSdkError()
  return {
    key: resourceKey(kind, entry.path),
    rawPath: entry.path,
    kind,
    name,
    scope: entry.scope,
    origin: entry.origin,
    rawSource: entry.source,
    baseDir: entry.baseDir,
    enabled: entry.enabled,
    modelInvocation: kind === 'extension' || kind === 'skill' ? 'unknown' : 'not-applicable',
    ownerPackageId: owner?.id ?? null,
    state: resourceState(entry.enabled, entry.scope, owner, input.scope),
    forceError: false
  }
}

function resourceFromLoaded(
  kind: Exclude<CapabilityInventoryResourceKind, 'extension'>,
  value: unknown,
  resolvedEntries: RawResolvedResource[],
  input: CapabilityInventoryWorkerInput,
  packageBySource: Map<string, RawPackageDeclaration>,
  completeness: CompletenessAccumulator
): ParsedLoadedResource {
  if (!isRecord(value)) return { state: 'invalid' }
  const sourceInfo = isRecord(value.sourceInfo) ? value.sourceInfo : null
  const sourceInfoScope = sourceInfo !== null && isScope(sourceInfo.scope) ? sourceInfo.scope : null
  if (sourceInfoScope !== null && !scopeIncluded(input.scope, sourceInfoScope)) return { state: 'excluded' }
  if (sourceInfoScope === 'project' && !input.projectTrusted) return { state: 'excluded' }

  const rawPathValue = kind === 'theme' ? value.sourcePath : value.filePath
  if (typeof rawPathValue !== 'string') return { state: 'invalid' }
  const rawPath = normalizePathString(rawPathValue)
  if (rawPath === null) return { state: 'invalid' }
  const matched = bestResolvedMatch(rawPath, resolvedEntries)
  const scope = sourceInfoScope ?? matched?.scope
  if (scope === undefined) return { state: 'invalid' }
  if (!scopeIncluded(input.scope, scope) || (scope === 'project' && !input.projectTrusted)) {
    return { state: 'excluded' }
  }
  const origin = sourceInfo !== null && isOrigin(sourceInfo.origin) ? sourceInfo.origin : matched?.origin
  const rawSourceValue = sourceInfo !== null && typeof sourceInfo.source === 'string'
    ? sourceInfo.source
    : matched?.source
  if (origin === undefined || rawSourceValue === undefined) return { state: 'invalid' }
  const rawSource = boundedInternalString(rawSourceValue, CAPABILITY_INVENTORY_LIMITS.sourceBytes)
  if (rawSource === null) return { state: 'invalid' }
  let baseDir = matched?.baseDir ?? null
  if (sourceInfo !== null && sourceInfo.baseDir !== undefined) {
    if (typeof sourceInfo.baseDir !== 'string') return { state: 'invalid' }
    baseDir = normalizePathString(sourceInfo.baseDir)
    if (baseDir === null) return { state: 'invalid' }
  }
  let name: string
  if (typeof value.name === 'string') {
    const normalized = normalizeCanonicalDisplay(value.name, CAPABILITY_INVENTORY_LIMITS.nameBytes)
    if (normalized === null) return { state: 'invalid' }
    name = normalized
  } else {
    completeness.markSdkError()
    name = fallbackResourceName(rawPath, kind, scope, origin, baseDir, input)
  }
  const owner = origin === 'package'
    ? packageBySource.get(`${scope}\0${rawSource}`) ?? null
    : null
  const enabled = matched?.enabled ?? true
  if (!describeResourceSource(rawSource, scope, input).valid) completeness.markSdkError()
  return {
    state: 'included',
    candidate: {
      key: resourceKey(kind, rawPath),
      rawPath,
      kind,
      name,
      scope,
      origin,
      rawSource,
      baseDir,
      enabled,
      modelInvocation: kind === 'skill'
        ? value.disableModelInvocation === true ? 'explicit-only' : 'allowed'
        : 'not-applicable',
      ownerPackageId: owner?.id ?? null,
      state: resourceState(enabled, scope, owner, input.scope),
      forceError: false
    }
  }
}

function collectResourceDiagnostics(
  defaultKind: Exclude<CapabilityInventoryResourceKind, 'extension'>,
  values: unknown[],
  candidates: Map<string, ResourceCandidate>,
  resolvedEntries: RawResolvedResource[],
  input: CapabilityInventoryWorkerInput,
  packageBySource: Map<string, RawPackageDeclaration>,
  diagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator,
  add: (candidate: ResourceCandidate) => void
): void {
  for (const value of values) {
    if (!isRecord(value)) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }
    const collisionValue = isRecord(value.collision) ? value.collision : null
    const kind = collisionValue !== null && isResourceKind(collisionValue.resourceType)
      ? collisionValue.resourceType
      : defaultKind
    const resourcePath = optionalDiagnosticPath(value.path)
    const winnerPath = optionalDiagnosticPath(collisionValue?.winnerPath)
    const loserPath = optionalDiagnosticPath(collisionValue?.loserPath)
    const paths = [winnerPath, loserPath, resourcePath].filter((path): path is string => path !== null)
    const includedPaths = paths.filter((path) => {
      const existing = candidates.get(resourceKey(kind, path))
      if (existing !== undefined) return true
      const matched = bestResolvedMatch(path, resolvedEntries)
      return matched !== null && scopeIncluded(input.scope, matched.scope) &&
        (matched.scope !== 'project' || input.projectTrusted)
    })
    if (paths.length > 0 && includedPaths.length === 0) continue

    const type = value.type
    if (!(type === 'collision' || type === 'warning' || type === 'error')) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }
    if (type === 'collision' && collisionValue === null) {
      completeness.markSdkError()
      pushDiagnostic(diagnostics, fixedDiagnostic('SDK_RESULT_INVALID', 'error', 'inventory'), truncation, completeness)
      continue
    }

    for (const path of includedPaths) {
      if (candidates.has(resourceKey(kind, path))) continue
      const matched = bestResolvedMatch(path, resolvedEntries)
      if (matched === null) continue
      const synthetic = resourceFromResolved(kind, { ...matched, path }, input, packageBySource, completeness)
      synthetic.forceError = path === loserPath || (path === resourcePath && type === 'error')
      add(synthetic)
    }
    if (loserPath !== null) {
      const loser = candidates.get(resourceKey(kind, loserPath))
      if (loser !== undefined) loser.forceError = true
    }
    if (resourcePath !== null && type === 'error') {
      const target = candidates.get(resourceKey(kind, resourcePath))
      if (target !== undefined) target.forceError = true
    }

    const code: CapabilityInventoryDiagnosticCode = type === 'collision'
      ? 'RESOURCE_COLLISION'
      : 'RESOURCE_VALIDATION'
    if (code === 'RESOURCE_VALIDATION') completeness.markSdkError()
    const targetPath = resourcePath ?? loserPath ?? winnerPath ?? undefined
    const diagnostic: DiagnosticCandidate = {
      ...fixedDiagnostic(
        code,
        type === 'warning' || type === 'collision' ? 'warning' : 'error',
        type === 'collision' ? 'collision' : 'validation'
      ),
      key: diagnosticKey(code, targetPath ?? '', kind),
      resourceKind: kind,
      resourcePath: targetPath
    }
    if (type === 'collision') {
      const winner = winnerPath === null ? undefined : candidates.get(resourceKey(kind, winnerPath))
      const loser = loserPath === null ? undefined : candidates.get(resourceKey(kind, loserPath))
      diagnostic.collision = {
        resourceKind: kind,
        name: winner?.name ?? loser?.name ?? 'unnamed',
        winnerPath,
        loserPath
      }
    }
    pushDiagnostic(diagnostics, diagnostic, truncation, completeness)
  }
}

function optionalDiagnosticPath(value: unknown): string | null {
  return typeof value === 'string' ? normalizePathString(value) : null
}

function finalizeSnapshot(
  input: CapabilityInventoryWorkerInput,
  rawPackages: RawPackageDeclaration[],
  rawResources: ResourceCandidate[],
  rawDiagnostics: DiagnosticCandidate[],
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): CapabilityInventorySnapshot {
  const sortedPackages = [...rawPackages].sort(compareRawPackages)
  if (sortedPackages.length > CAPABILITY_INVENTORY_LIMITS.packages) {
    truncation.packages = true
    completeness.markLimit()
  }
  const sortedResources = [...rawResources].sort(compareResourceCandidates)
  if (sortedResources.length > CAPABILITY_INVENTORY_LIMITS.resources) {
    truncation.resources = true
    completeness.markLimit()
  }

  let packageLimit = Math.min(sortedPackages.length, CAPABILITY_INVENTORY_LIMITS.packages)
  let resourceLimit = Math.min(sortedResources.length, CAPABILITY_INVENTORY_LIMITS.resources)
  let diagnosticLimit: number = CAPABILITY_INVENTORY_LIMITS.diagnostics

  for (let attempt = 0; attempt < 64; attempt += 1) {
    if (completeness.hasLimit()) ensureLimitDiagnostic(rawDiagnostics)
    const uniqueDiagnostics = uniqueSortedDiagnostics(rawDiagnostics)
    if (uniqueDiagnostics.length > CAPABILITY_INVENTORY_LIMITS.diagnostics) {
      truncation.diagnostics = true
      completeness.markLimit()
    }
    diagnosticLimit = Math.min(diagnosticLimit, uniqueDiagnostics.length, CAPABILITY_INVENTORY_LIMITS.diagnostics)

    const built = buildSnapshotWithLimits({
      input,
      sortedPackages,
      sortedResources,
      sortedDiagnostics: uniqueDiagnostics,
      packageLimit,
      resourceLimit,
      diagnosticLimit,
      truncation,
      completeness
    })
    if (built.ownerDropped) {
      truncation.resources = true
      completeness.markLimit()
      if (!rawDiagnostics.some((candidate) => candidate.code === 'LIMIT_EXCEEDED')) {
        ensureLimitDiagnostic(rawDiagnostics)
        continue
      }
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(built.snapshot), 'utf8')
    if (serializedBytes <= CAPABILITY_INVENTORY_LIMITS.serializedSnapshotBytes) return built.snapshot

    completeness.markLimit()
    const contributions = [
      { kind: 'packages' as const, count: packageLimit, bytes: serializedArrayBytes(built.snapshot.packages) },
      { kind: 'resources' as const, count: resourceLimit, bytes: serializedArrayBytes(built.snapshot.resources) },
      { kind: 'diagnostics' as const, count: diagnosticLimit, bytes: serializedArrayBytes(built.snapshot.diagnostics) }
    ].filter((entry) => entry.count > 0).sort((a, b) => b.bytes - a.bytes || compareOrdinal(a.kind, b.kind))
    const largest = contributions[0]
    if (largest === undefined) throw new Error('Capability inventory snapshot budget is invalid.')
    const reduction = Math.max(1, Math.ceil(largest.count / 4))
    if (largest.kind === 'packages') {
      packageLimit = Math.max(0, packageLimit - reduction)
      truncation.packages = true
    } else if (largest.kind === 'resources') {
      resourceLimit = Math.max(0, resourceLimit - reduction)
      truncation.resources = true
    } else {
      diagnosticLimit = Math.max(0, diagnosticLimit - reduction)
      truncation.diagnostics = true
    }
  }
  throw new Error('Capability inventory snapshot could not fit its producer budget.')
}

function buildSnapshotWithLimits(options: {
  input: CapabilityInventoryWorkerInput
  sortedPackages: RawPackageDeclaration[]
  sortedResources: ResourceCandidate[]
  sortedDiagnostics: DiagnosticCandidate[]
  packageLimit: number
  resourceLimit: number
  diagnosticLimit: number
  truncation: CapabilityInventorySnapshot['truncated']
  completeness: CompletenessAccumulator
}): { snapshot: CapabilityInventorySnapshot, ownerDropped: boolean } {
  const selectedRawPackages = options.sortedPackages.slice(0, options.packageLimit)
  const packageIds = new Set(selectedRawPackages.map((pkg) => pkg.id))
  let ownerDropped = false
  const ownerClosedResources: ResourceCandidate[] = []
  for (const resource of options.sortedResources) {
    if (resource.ownerPackageId !== null && !packageIds.has(resource.ownerPackageId)) {
      ownerDropped = true
      continue
    }
    ownerClosedResources.push(resource)
  }
  const selectedResourceCandidates = ownerClosedResources.slice(0, options.resourceLimit)
  const resourceIdByKey = new Map<string, string>()
  for (const candidate of selectedResourceCandidates) {
    resourceIdByKey.set(
      candidate.key,
      stableId('res', `${candidate.kind}\0${candidate.scope}\0${candidate.rawPath}\0${candidate.name}`)
    )
  }

  const selectedDiagnosticCandidates = options.sortedDiagnostics.slice(0, options.diagnosticLimit)
  const diagnostics: CapabilityInventoryDiagnostic[] = selectedDiagnosticCandidates.map((candidate) => {
    const resourceId = candidate.resourceKind !== undefined && candidate.resourcePath !== undefined
      ? resourceIdByKey.get(resourceKey(candidate.resourceKind, candidate.resourcePath)) ?? null
      : null
    return {
      id: stableId('diag', candidate.key),
      code: candidate.code,
      severity: candidate.severity,
      kind: candidate.kind,
      resourceId,
      message: CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES[candidate.code],
      collision: candidate.collision === undefined ? null : {
        resourceKind: candidate.collision.resourceKind,
        name: normalizeFixedOrCanonicalName(candidate.collision.name),
        winnerResourceId: candidate.collision.winnerPath === null
          ? null
          : resourceIdByKey.get(resourceKey(candidate.collision.resourceKind, candidate.collision.winnerPath)) ?? null,
        loserResourceId: candidate.collision.loserPath === null
          ? null
          : resourceIdByKey.get(resourceKey(candidate.collision.resourceKind, candidate.collision.loserPath)) ?? null
      }
    }
  })

  const diagnosticIdsByResource = new Map<string, string[]>()
  const diagnosticIdsByPackage = new Map<string, string[]>()
  for (let index = 0; index < selectedDiagnosticCandidates.length; index += 1) {
    const candidate = selectedDiagnosticCandidates[index]!
    const diagnostic = diagnostics[index]!
    if (diagnostic.resourceId !== null) pushId(diagnosticIdsByResource, diagnostic.resourceId, diagnostic.id)
    if (candidate.packageId !== undefined && packageIds.has(candidate.packageId)) {
      pushId(diagnosticIdsByPackage, candidate.packageId, diagnostic.id)
    }
  }

  const resources: CapabilityInventoryResource[] = selectedResourceCandidates.map((candidate) => {
    const id = resourceIdByKey.get(candidate.key) as string
    return {
      id,
      inventoryState: 'static-resolved',
      runtimeEffectiveState: 'not-observed',
      kind: candidate.kind,
      name: candidate.name,
      scope: candidate.scope,
      origin: candidate.origin,
      ownerPackageId: candidate.ownerPackageId,
      source: describeResourceSource(candidate.rawSource, candidate.scope, options.input).source,
      displayPath: displayResourcePath(
        candidate.rawPath,
        candidate.scope,
        candidate.origin,
        candidate.baseDir,
        options.input
      ),
      declaredEnabled: candidate.enabled,
      state: candidate.forceError ? 'error' : candidate.state,
      modelInvocation: candidate.modelInvocation,
      diagnosticIds: (diagnosticIdsByResource.get(id) ?? []).slice(0, CAPABILITY_INVENTORY_LIMITS.diagnosticIdsPerResource)
    }
  })

  const resourceCounts = new Map<string, CapabilityInventoryPackage['resourceCounts']>()
  const resourceCountsTruncated = new Set<string>()
  for (const candidate of options.sortedResources) {
    if (candidate.ownerPackageId === null || !packageIds.has(candidate.ownerPackageId)) continue
    const counts = resourceCounts.get(candidate.ownerPackageId) ?? {
      extensions: 0, skills: 0, prompts: 0, themes: 0
    }
    const key = `${candidate.kind}s` as keyof typeof counts
    if (counts[key] < CAPABILITY_INVENTORY_LIMITS.resources) counts[key] += 1
    else resourceCountsTruncated.add(candidate.ownerPackageId)
    resourceCounts.set(candidate.ownerPackageId, counts)
  }

  const packages: CapabilityInventoryPackage[] = selectedRawPackages.map((pkg) => ({
    id: pkg.id,
    inventoryState: 'static-declaration',
    scope: pkg.scope,
    source: pkg.source,
    sourceKind: pkg.sourceKind,
    packageName: pkg.packageName,
    requestedVersionOrRef: pkg.requestedVersionOrRef,
    installedVersion: null,
    installed: pkg.installed,
    filtered: pkg.filtered,
    autoload: pkg.autoload,
    state: pkg.state,
    effective: pkg.effective,
    resourceCounts: resourceCounts.get(pkg.id) ?? {
      extensions: 0, skills: 0, prompts: 0, themes: 0
    },
    resourceCountsTruncated: resourceCountsTruncated.has(pkg.id),
    diagnosticIds: (diagnosticIdsByPackage.get(pkg.id) ?? []).slice(0, CAPABILITY_INVENTORY_LIMITS.diagnosticIdsPerResource)
  }))

  syncLimits(options.truncation, options.completeness)
  const reason = options.completeness.reason()
  return {
    ownerDropped,
    snapshot: {
      schemaVersion: CAPABILITY_INVENTORY_SCHEMA_VERSION,
      inventoryKind: 'static-resolved-not-runtime-effective',
      requestedScope: options.input.scope,
      projectTrusted: options.input.projectTrusted,
      resolvedComplete: reason === null,
      resolvedUnavailableReason: reason,
      packages,
      resources,
      diagnostics,
      truncated: { ...options.truncation }
    }
  }
}

function uniqueSortedDiagnostics(rawDiagnostics: DiagnosticCandidate[]): DiagnosticCandidate[] {
  const unique = new Map<string, DiagnosticCandidate>()
  for (const diagnostic of rawDiagnostics) {
    if (!unique.has(diagnostic.key)) unique.set(diagnostic.key, diagnostic)
  }
  return [...unique.values()].sort(compareDiagnosticCandidates)
}

function ensureLimitDiagnostic(diagnostics: DiagnosticCandidate[]): void {
  const diagnostic = fixedDiagnostic('LIMIT_EXCEEDED', 'warning', 'inventory')
  if (!diagnostics.some((candidate) => candidate.key === diagnostic.key)) diagnostics.push(diagnostic)
}

function serializedArrayBytes(value: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function fixedDiagnostic(
  code: CapabilityInventoryDiagnosticCode,
  _severity?: 'warning' | 'error',
  _kind?: CapabilityInventoryDiagnostic['kind']
): DiagnosticCandidate {
  const policy = CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES[code]
  return { key: diagnosticKey(code, '', ''), code, severity: policy.severity, kind: policy.kind }
}

function pushDiagnostic(
  diagnostics: DiagnosticCandidate[],
  diagnostic: DiagnosticCandidate,
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): void {
  if (diagnostics.length >= MAX_INTERNAL_DIAGNOSTICS) {
    truncation.diagnostics = true
    completeness.markLimit()
    return
  }
  diagnostics.push(diagnostic)
}

function syncLimits(
  truncation: CapabilityInventorySnapshot['truncated'],
  completeness: CompletenessAccumulator
): void {
  if (truncation.packages || truncation.resources || truncation.diagnostics ||
    truncation.canonicalEffectiveResources) completeness.markLimit()
}

function describePackageSource(
  rawSource: string,
  scope: CapabilityInventoryScope,
  input: CapabilityInventoryWorkerInput
): PackageSourceDescription {
  const npm = parseNpmSource(rawSource)
  if (npm !== null) {
    return {
      source: npm.version === null ? `npm:${npm.name}` : `npm:${npm.name}@${npm.version}`,
      kind: 'npm',
      packageName: npm.name,
      requestedVersionOrRef: npm.version,
      identity: `npm:${npm.name}`,
      valid: true
    }
  }
  if (rawSource.startsWith('npm:')) return invalidPackageDescription()

  const git = parseGitSource(rawSource)
  if (git !== null) {
    return {
      source: git.ref === null ? `git:${git.identity}` : `git:${git.identity}@${git.ref}`,
      kind: 'git',
      packageName: null,
      requestedVersionOrRef: git.ref,
      identity: `git:${git.identity}`,
      valid: true
    }
  }
  if (looksGitLike(rawSource)) return invalidPackageDescription()

  if (looksLocalSource(rawSource) && isSafeLocalSource(rawSource)) {
    return {
      source: displayLocalSource(rawSource, scope, input),
      kind: 'local',
      packageName: null,
      requestedVersionOrRef: null,
      identity: `local:${resolvedLocalIdentity(rawSource, scope, input)}`,
      valid: true
    }
  }
  return invalidPackageDescription()
}

function invalidPackageDescription(): PackageSourceDescription {
  return {
    source: '[redacted-source]',
    kind: 'unknown',
    packageName: null,
    requestedVersionOrRef: null,
    identity: null,
    valid: false
  }
}

function describeResourceSource(
  rawSource: string,
  scope: CapabilityInventoryScope,
  input: CapabilityInventoryWorkerInput
): { source: string, valid: boolean } {
  if (rawSource === 'local' || rawSource === 'auto') return { source: `[local:${scope}]`, valid: true }
  const described = describePackageSource(rawSource, scope, input)
  return { source: described.source, valid: described.valid }
}

function parseNpmSource(source: string): { name: string, version: string | null } | null {
  if (!source.startsWith('npm:') || !isSafeScalarString(source) || /[?#]/u.test(source)) return null
  const spec = source.slice(4)
  let split = -1
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash < 2) return null
    split = spec.indexOf('@', slash)
  } else {
    split = spec.lastIndexOf('@')
  }
  const name = split > 0 ? spec.slice(0, split) : spec
  const version = split > 0 ? spec.slice(split + 1) : null
  if (!SAFE_NPM_NAME.test(name) || Buffer.byteLength(name, 'utf8') > CAPABILITY_INVENTORY_LIMITS.nameBytes) return null
  if (version !== null && (version.length === 0 ||
    Buffer.byteLength(version, 'utf8') > CAPABILITY_INVENTORY_LIMITS.versionOrRefBytes ||
    !SAFE_VERSION_OR_REF.test(version))) return null
  return { name, version }
}

function parseGitSource(source: string): { identity: string, ref: string | null } | null {
  if (!isSafeScalarString(source) || /[\s?#]/u.test(source)) return null
  const hadPrefix = source.startsWith('git:')
  let spec = hadPrefix ? source.slice(4) : source
  let ref: string | null = null
  const lastAt = spec.lastIndexOf('@')
  const lastSeparator = Math.max(spec.lastIndexOf('/'), spec.lastIndexOf(':'))
  if (lastAt > lastSeparator) {
    ref = spec.slice(lastAt + 1)
    spec = spec.slice(0, lastAt)
    if (ref.length === 0 || Buffer.byteLength(ref, 'utf8') > CAPABILITY_INVENTORY_LIMITS.versionOrRefBytes ||
      !SAFE_VERSION_OR_REF.test(ref)) return null
  }

  if (/^(?:https?|ssh|git):\/\//u.test(spec)) {
    let url: URL
    try { url = new URL(spec) } catch { return null }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null
    if (url.password.length > 0) return null
    if (url.username.length > 0 && !(url.protocol === 'ssh:' && url.username === 'git')) return null
    if (!SAFE_GIT_HOST.test(url.hostname)) return null
    const path = url.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
    if (path.length === 0 || !SAFE_GIT_PATH.test(path)) return null
    return { identity: `${url.hostname.toLowerCase()}/${path.toLowerCase()}`, ref }
  }

  if (!hadPrefix) return null
  const match = /^(?:(git)@)?([^:/]+)[:/]([^\s]+)$/u.exec(spec)
  if (match === null || !SAFE_GIT_HOST.test(match[2]!) || !SAFE_GIT_PATH.test(match[3]!)) return null
  const path = match[3]!.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  if (path.length === 0) return null
  return { identity: `${match[2]!.toLowerCase()}/${path.toLowerCase()}`, ref }
}

function looksGitLike(source: string): boolean {
  return source.startsWith('git:') || /^(?:https?|ssh|git):\/\//u.test(source) ||
    /^(?:[^@/\s]+@)?[^:/\s]+:[^\s]+/u.test(source)
}

function looksLocalSource(source: string): boolean {
  return source.startsWith('local:') || source.startsWith('./') || source.startsWith('../') || isAbsolute(source)
}

function isSafeLocalSource(source: string): boolean {
  const path = source.startsWith('local:') ? source.slice(6) : source
  return path.length > 0 && isSafeScalarString(path) && !/[\u0000-\u001f\u007f]/u.test(path)
}

function resolvedLocalIdentity(
  source: string,
  scope: CapabilityInventoryScope,
  input: CapabilityInventoryWorkerInput
): string {
  const local = source.startsWith('local:') ? source.slice(6) : source
  const base = scope === 'user' ? input.agentDir : resolve(input.cwd, '.pi')
  return resolve(base, local)
}

function displayLocalSource(
  rawSource: string,
  scope: CapabilityInventoryScope,
  input: CapabilityInventoryWorkerInput
): string {
  const local = rawSource.startsWith('local:') ? rawSource.slice(6) : rawSource
  if (!isAbsolute(local)) {
    const normalized = local.replaceAll('\\', '/').replace(/^\.\//u, '')
    const display = `[local:${scope}]/${normalized}`
    return Buffer.byteLength(display, 'utf8') <= CAPABILITY_INVENTORY_LIMITS.sourceBytes
      ? display
      : `[local:${scope}]/[external]`
  }
  for (const root of knownRoots(input)) {
    const child = safeRelative(root.path, local)
    if (child !== null) {
      const display = `[local:${scope}:${root.label}]/${child.replaceAll(sep, '/') || '.'}`
      return Buffer.byteLength(display, 'utf8') <= CAPABILITY_INVENTORY_LIMITS.sourceBytes
        ? display
        : `[local:${scope}]/[external]`
    }
  }
  return `[local:${scope}]/[external]`
}

function displayResourcePath(
  rawPath: string,
  scope: CapabilityInventoryScope,
  origin: CapabilityInventoryOrigin,
  baseDir: string | null,
  input: CapabilityInventoryWorkerInput
): string {
  const roots: Array<{ label: string, path: string }> = []
  if (origin === 'package' && baseDir !== null && isAbsolute(baseDir)) {
    roots.push({ label: 'package', path: baseDir })
  }
  roots.push(...knownRoots(input).filter((root) =>
    scope === 'user' ? root.label === 'user' : root.label === 'project' || root.label === 'project-settings'))
  if (isAbsolute(rawPath)) {
    for (const root of roots) {
      const child = safeRelative(root.path, rawPath)
      if (child !== null) {
        const display = `[${root.label}]/${child.replaceAll(sep, '/') || '.'}`
        return Buffer.byteLength(display, 'utf8') <= CAPABILITY_INVENTORY_LIMITS.displayPathBytes
          ? display
          : `[${scope}]/[external]`
      }
    }
    return `[${scope}]/[external]`
  }
  const display = `[${scope}]/${rawPath.replaceAll('\\', '/').replace(/^\.\//u, '')}`
  return Buffer.byteLength(display, 'utf8') <= CAPABILITY_INVENTORY_LIMITS.displayPathBytes
    ? display
    : `[${scope}]/[external]`
}

function knownRoots(input: CapabilityInventoryWorkerInput): Array<{ label: string, path: string }> {
  return [
    { label: 'user', path: input.agentDir },
    { label: 'project', path: input.cwd },
    { label: 'project-settings', path: resolve(input.cwd, '.pi') }
  ]
}

function safeRelative(root: string, candidate: string): string | null {
  const child = relative(resolve(root), resolve(candidate))
  if (child === '') return ''
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return null
  return child
}

function resourceState(
  enabled: boolean,
  scope: CapabilityInventoryScope,
  owner: RawPackageDeclaration | null,
  requestedScope: CapabilityInventoryScopeRequest
): CapabilityInventoryItemState {
  if (!enabled) return 'disabled'
  if (requestedScope !== 'effective') return 'declared'
  if (scope === 'user') return 'inherited'
  if (owner?.state === 'project-delta') return 'project-delta'
  if (owner?.state === 'project-override') return 'project-override'
  return 'declared'
}

function fallbackResourceName(
  path: string,
  kind: CapabilityInventoryResourceKind,
  scope: CapabilityInventoryScope,
  origin: CapabilityInventoryOrigin,
  baseDir: string | null,
  input: CapabilityInventoryWorkerInput
): string {
  const display = displayResourcePath(path, scope, origin, baseDir, input)
  if (display.endsWith('/[external]')) return kind
  const file = basename(path)
  const extension = extname(file)
  const name = (extension.length > 0 ? file.slice(0, -extension.length) : file).normalize('NFC') || kind
  if (!isSafeScalarString(name) || /[\u0000-\u001f\u007f]/u.test(name) ||
    Buffer.byteLength(name, 'utf8') > CAPABILITY_INVENTORY_LIMITS.nameBytes) return kind
  return name
}

function normalizeFixedOrCanonicalName(value: string): string {
  const normalized = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return truncateUtf8(normalized || 'unnamed', CAPABILITY_INVENTORY_LIMITS.nameBytes)
}

function normalizeCanonicalDisplay(value: string, maximumBytes: number): string | null {
  if (!isSafeScalarString(value) || /[\u0000-\u001f\u007f]/u.test(value)) return null
  const normalized = value.normalize('NFC')
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > maximumBytes) return null
  return normalized
}

function bestResolvedMatch(path: string, resolvedEntries: RawResolvedResource[]): RawResolvedResource | null {
  let best: RawResolvedResource | null = null
  for (const entry of resolvedEntries) {
    if (!isPathAtOrBelow(path, entry.path)) continue
    if (best === null || entry.path.length > best.path.length) best = entry
  }
  return best
}

function isPathAtOrBelow(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate)
  const normalizedRoot = resolve(root)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
}

function compareRawPackages(a: RawPackageDeclaration, b: RawPackageDeclaration): number {
  return SOURCE_SCOPE_ORDER[a.scope] - SOURCE_SCOPE_ORDER[b.scope] ||
    compareOrdinal(a.source, b.source) || compareOrdinal(a.id, b.id)
}

function compareResourceCandidates(a: ResourceCandidate, b: ResourceCandidate): number {
  return RESOURCE_KIND_ORDER[a.kind] - RESOURCE_KIND_ORDER[b.kind] ||
    compareOrdinal(a.name, b.name) ||
    SOURCE_SCOPE_ORDER[a.scope] - SOURCE_SCOPE_ORDER[b.scope] ||
    compareOrdinal(resourceCandidateId(a), resourceCandidateId(b))
}

function resourceCandidateId(candidate: ResourceCandidate): string {
  return stableId('res', `${candidate.kind}\0${candidate.scope}\0${candidate.rawPath}\0${candidate.name}`)
}

function compareDiagnosticCandidates(a: DiagnosticCandidate, b: DiagnosticCandidate): number {
  return compareOrdinal(a.code, b.code) ||
    compareOrdinal(stableId('diag', a.key), stableId('diag', b.key))
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function scopeIncluded(request: CapabilityInventoryScopeRequest, scope: CapabilityInventoryScope): boolean {
  return request === 'effective' || request === scope
}

function pushId(map: Map<string, string[]>, key: string, id: string): void {
  const values = map.get(key) ?? []
  if (values.length < CAPABILITY_INVENTORY_LIMITS.diagnosticIdsPerResource && !values.includes(id)) values.push(id)
  map.set(key, values)
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

function resourceKey(kind: CapabilityInventoryResourceKind, path: string): string {
  return `${kind}\0${resolve(path)}`
}

function diagnosticKey(code: string, target: string, discriminator: string): string {
  return `${code}\0${target}\0${discriminator}`
}

function normalizePathString(value: string): string | null {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 16_384 ||
    /[\u0000\r\n]/u.test(value) || !isSafeScalarString(value)) return null
  return value
}

function boundedInternalString(value: string, maximumBytes: number): string | null {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes || !isSafeScalarString(value)) return null
  return value
}

function isSafeScalarString(value: string): boolean {
  return !hasLoneSurrogate(value)
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let output = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maximumBytes) break
    output += character
    bytes += characterBytes
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
