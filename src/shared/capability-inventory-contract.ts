export const CAPABILITY_INVENTORY_SCHEMA_VERSION = 1 as const

/**
 * Canonical producer and transport limits. All string limits are UTF-8 byte limits,
 * not UTF-16 lengths. The worker must emit a serialized snapshot within
 * `serializedSnapshotBytes`; Main allows only the small fixed JSON envelope overhead above it.
 */
export const CAPABILITY_INVENTORY_LIMITS = Object.freeze({
  packages: 512,
  resources: 4096,
  diagnostics: 1024,
  diagnosticIdsPerResource: 32,
  idBytes: 96,
  nameBytes: 256,
  sourceBytes: 2048,
  displayPathBytes: 1024,
  versionOrRefBytes: 256,
  messageBytes: 256,
  requestBytes: 32 * 1024,
  serializedSnapshotBytes: 4 * 1024 * 1024,
  workerResponseBytes: 4 * 1024 * 1024 + 64 * 1024
})

export type CapabilityInventoryScopeRequest = 'user' | 'project' | 'effective'
export type CapabilityInventoryScope = 'user' | 'project'
export type CapabilityInventoryOrigin = 'package' | 'top-level'
export type CapabilityInventoryResourceKind = 'extension' | 'skill' | 'prompt' | 'theme'
export type CapabilityInventoryItemState =
  | 'declared'
  | 'inherited'
  | 'project-override'
  | 'project-delta'
  | 'disabled'
  | 'unknown'
  | 'error'

export type CapabilityInventorySourceKind = 'npm' | 'git' | 'local' | 'unknown'

export type CapabilityInventoryDiagnosticCode =
  | 'INVENTORY_WORKER_FAILED'
  | 'INVENTORY_WORKER_TIMEOUT'
  | 'INVENTORY_WORKER_ABORTED'
  | 'PI_ROOT_IMPORT_FAILED'
  | 'PI_SDK_SHAPE_INVALID'
  | 'SETTINGS_CREATE_FAILED'
  | 'SETTINGS_LOAD_FAILED'
  | 'PACKAGE_LIST_FAILED'
  | 'PACKAGE_RESOLVE_FAILED'
  | 'PACKAGE_MISSING_OFFLINE'
  | 'RESOURCE_LOADER_FAILED'
  | 'SDK_RESULT_INVALID'
  | 'RESOURCE_VALIDATION'
  | 'RESOURCE_COLLISION'
  | 'FIELD_INVALID'
  | 'LIMIT_EXCEEDED'
  | 'PROJECT_SCOPE_EXCLUDED'

export type CapabilityInventoryDiagnosticSeverity = 'warning' | 'error'
export type CapabilityInventoryDiagnosticKind = 'validation' | 'missing' | 'collision' | 'load' | 'inventory'

/** Canonical public diagnostic semantics. No worker-controlled severity, kind, or text is accepted. */
export const CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES: Readonly<Record<CapabilityInventoryDiagnosticCode, {
  severity: CapabilityInventoryDiagnosticSeverity
  kind: CapabilityInventoryDiagnosticKind
  collision: 'required' | 'forbidden'
}>> = Object.freeze({
  INVENTORY_WORKER_FAILED: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  INVENTORY_WORKER_TIMEOUT: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  INVENTORY_WORKER_ABORTED: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  PI_ROOT_IMPORT_FAILED: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  PI_SDK_SHAPE_INVALID: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  SETTINGS_CREATE_FAILED: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  SETTINGS_LOAD_FAILED: { severity: 'error', kind: 'validation', collision: 'forbidden' },
  PACKAGE_LIST_FAILED: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  PACKAGE_RESOLVE_FAILED: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  PACKAGE_MISSING_OFFLINE: { severity: 'warning', kind: 'missing', collision: 'forbidden' },
  RESOURCE_LOADER_FAILED: { severity: 'error', kind: 'load', collision: 'forbidden' },
  SDK_RESULT_INVALID: { severity: 'error', kind: 'inventory', collision: 'forbidden' },
  RESOURCE_VALIDATION: { severity: 'error', kind: 'validation', collision: 'forbidden' },
  RESOURCE_COLLISION: { severity: 'warning', kind: 'collision', collision: 'required' },
  FIELD_INVALID: { severity: 'error', kind: 'validation', collision: 'forbidden' },
  LIMIT_EXCEEDED: { severity: 'warning', kind: 'inventory', collision: 'forbidden' },
  PROJECT_SCOPE_EXCLUDED: { severity: 'warning', kind: 'inventory', collision: 'forbidden' }
})

/** Public diagnostics are category labels, never reflected Error or Pi diagnostic text. */
export const CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES: Readonly<Record<CapabilityInventoryDiagnosticCode, string>> = Object.freeze({
  INVENTORY_WORKER_FAILED: 'Capability inventory worker failed.',
  INVENTORY_WORKER_TIMEOUT: 'Capability inventory worker timed out.',
  INVENTORY_WORKER_ABORTED: 'Capability inventory worker was aborted.',
  PI_ROOT_IMPORT_FAILED: 'The configured Pi package root could not be imported.',
  PI_SDK_SHAPE_INVALID: 'The Pi package root does not expose the required inventory API.',
  SETTINGS_CREATE_FAILED: 'Pi settings could not be opened.',
  SETTINGS_LOAD_FAILED: 'Pi settings could not be parsed.',
  PACKAGE_LIST_FAILED: 'Configured Pi packages could not be listed.',
  PACKAGE_RESOLVE_FAILED: 'Pi package resources could not be resolved.',
  PACKAGE_MISSING_OFFLINE: 'A configured package is unavailable; offline inventory did not install it.',
  RESOURCE_LOADER_FAILED: 'Static Pi resources could not be loaded.',
  SDK_RESULT_INVALID: 'Pi returned an invalid inventory result.',
  RESOURCE_VALIDATION: 'Pi reported an invalid resource declaration.',
  RESOURCE_COLLISION: 'Pi reported a resource-name collision.',
  FIELD_INVALID: 'Pi returned an invalid canonical inventory field.',
  LIMIT_EXCEEDED: 'Capability inventory exceeded a canonical producer limit and was truncated.',
  PROJECT_SCOPE_EXCLUDED: 'Project declarations and resources were excluded by the caller-provided trust decision.'
})

export type CapabilityInventoryPackage = {
  id: string
  inventoryState: 'static-declaration'
  scope: CapabilityInventoryScope
  source: string
  sourceKind: CapabilityInventorySourceKind
  packageName: string | null
  requestedVersionOrRef: string | null
  installedVersion: null
  installed: boolean
  filtered: boolean
  autoload: boolean | null
  state: CapabilityInventoryItemState
  effective: boolean | null
  resourceCounts: {
    extensions: number
    skills: number
    prompts: number
    themes: number
  }
  resourceCountsTruncated: boolean
  diagnosticIds: string[]
}

export type CapabilityInventoryResource = {
  id: string
  inventoryState: 'static-resolved'
  /** This service never observes or claims runtime-active state. */
  runtimeEffectiveState: 'not-observed'
  kind: CapabilityInventoryResourceKind
  name: string
  scope: CapabilityInventoryScope
  origin: CapabilityInventoryOrigin
  ownerPackageId: string | null
  source: string
  displayPath: string
  declaredEnabled: boolean
  state: CapabilityInventoryItemState
  modelInvocation: 'allowed' | 'explicit-only' | 'not-applicable' | 'unknown'
  diagnosticIds: string[]
}

export type CapabilityInventoryCollision = {
  resourceKind: CapabilityInventoryResourceKind
  name: string
  winnerResourceId: string | null
  loserResourceId: string | null
}

export type CapabilityInventoryDiagnostic = {
  id: string
  code: CapabilityInventoryDiagnosticCode
  severity: CapabilityInventoryDiagnosticSeverity
  kind: CapabilityInventoryDiagnosticKind
  resourceId: string | null
  message: string
  collision: CapabilityInventoryCollision | null
}

export type CapabilityInventoryTruncation = {
  packages: boolean
  resources: boolean
  diagnostics: boolean
  canonicalEffectiveResources: boolean
}

/**
 * A bounded, secret-safe static declaration/resolution snapshot.
 *
 * It is deliberately not runtime-effective inventory. In particular, it never reports
 * Extension tools, commands, factories, runtime health, active state, or dynamic resources.
 */
export type CapabilityInventorySnapshot = {
  schemaVersion: typeof CAPABILITY_INVENTORY_SCHEMA_VERSION
  inventoryKind: 'static-resolved-not-runtime-effective'
  requestedScope: CapabilityInventoryScopeRequest
  projectTrusted: boolean
  resolvedComplete: boolean
  resolvedUnavailableReason: 'offline-missing-package' | 'sdk-error' | 'limit' | null
  packages: CapabilityInventoryPackage[]
  resources: CapabilityInventoryResource[]
  diagnostics: CapabilityInventoryDiagnostic[]
  truncated: CapabilityInventoryTruncation
}
