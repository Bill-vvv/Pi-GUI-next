/**
 * Narrow, version-guarded private bridge into Pi 0.80.10 ExtensionRunner.
 *
 * ExtensionContext does not expose ResourceLoader. Before any runner instance is
 * used, patch ExtensionRunner.prototype so createContext/createCommandContext
 * attach non-enumerable Symbol.for accessors that return getExtensionPaths() and
 * allow hardcoded read-only registered-tool invocation. If the class/API/version
 * cannot be proven, inventory stays unknown and prepare fails closed.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  EXTENSION_INVENTORY_ACCESSOR,
  EXTENSION_TOOL_INVOKE_ACCESSOR,
  SUPPORTED_PI_CODING_AGENT_VERSION
} from './protocol.mjs'

/** @type {{ ok: true } | { ok: false, reason: string } | null} */
let installState = null

/**
 * Best-effort install. Safe to call multiple times; first result wins.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function ensureExtensionRunnerInventoryBridge() {
  if (installState !== null) return installState
  installState = await installBridgeOnce()
  return installState
}

/**
 * Test-only reset so pure protocol suites can re-run install paths.
 */
export function resetExtensionRunnerInventoryBridgeForTests() {
  installState = null
}

/**
 * @param {unknown} ctx
 * @returns {string[] | null}
 */
export function readExtensionInventoryFromContext(ctx) {
  if (ctx === null || typeof ctx !== 'object') return null
  const accessor = /** @type {Record<PropertyKey, unknown>} */ (ctx)[EXTENSION_INVENTORY_ACCESSOR]
  if (typeof accessor !== 'function') return null
  try {
    const paths = accessor.call(ctx)
    if (!Array.isArray(paths)) return null
    if (!paths.every((entry) => typeof entry === 'string')) return null
    return paths
  } catch {
    return null
  }
}

/**
 * Invoke a registered tool definition through the private runner bridge.
 * Callers must only pass hardcoded read-only management actions.
 *
 * @param {unknown} ctx
 * @param {string} toolName
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown | null>}
 */
export async function invokeRegisteredToolFromContext(ctx, toolName, params) {
  if (ctx === null || typeof ctx !== 'object') return null
  if (typeof toolName !== 'string' || toolName.length === 0) return null
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  const accessor = /** @type {Record<PropertyKey, unknown>} */ (ctx)[EXTENSION_TOOL_INVOKE_ACCESSOR]
  if (typeof accessor !== 'function') return null
  try {
    return await accessor.call(ctx, toolName, params)
  } catch {
    return null
  }
}

async function installBridgeOnce() {
  try {
    const resolved = await resolvePiCodingAgentModule()
    if (!resolved.ok) return resolved

    const ExtensionRunner = resolved.module.ExtensionRunner
    if (typeof ExtensionRunner !== 'function') {
      return { ok: false, reason: 'extension-runner-missing' }
    }
    const prototype = ExtensionRunner.prototype
    if (
      prototype === null ||
      typeof prototype !== 'object' ||
      typeof prototype.createContext !== 'function' ||
      typeof prototype.createCommandContext !== 'function' ||
      typeof prototype.getExtensionPaths !== 'function' ||
      typeof prototype.getToolDefinition !== 'function'
    ) {
      return { ok: false, reason: 'extension-runner-api-mismatch' }
    }

    if (prototype.__piGuiHibernateLeaseBridgeInstalled === true) {
      return { ok: true }
    }

    const originalCreateContext = prototype.createContext
    const originalCreateCommandContext = prototype.createCommandContext

    prototype.createContext = function patchedCreateContext(...args) {
      const ctx = originalCreateContext.apply(this, args)
      return attachInventoryAccessors(ctx, this)
    }

    prototype.createCommandContext = function patchedCreateCommandContext(...args) {
      const ctx = originalCreateCommandContext.apply(this, args)
      return attachInventoryAccessors(ctx, this)
    }

    Object.defineProperty(prototype, '__piGuiHibernateLeaseBridgeInstalled', {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    })
    return { ok: true }
  } catch {
    return { ok: false, reason: 'bridge-install-failed' }
  }
}

/**
 * @param {object} ctx
 * @param {object} runner
 */
function attachInventoryAccessors(ctx, runner) {
  if (ctx === null || typeof ctx !== 'object') return ctx
  if (Object.prototype.hasOwnProperty.call(ctx, EXTENSION_INVENTORY_ACCESSOR)) {
    return ctx
  }

  Object.defineProperty(ctx, EXTENSION_INVENTORY_ACCESSOR, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: () => {
      if (typeof runner.getExtensionPaths !== 'function') {
        throw new Error('getExtensionPaths unavailable')
      }
      const paths = runner.getExtensionPaths()
      if (!Array.isArray(paths)) throw new Error('getExtensionPaths invalid')
      return paths.map((entry) => {
        if (typeof entry !== 'string') throw new Error('getExtensionPaths entry invalid')
        return entry
      })
    }
  })

  Object.defineProperty(ctx, EXTENSION_TOOL_INVOKE_ACCESSOR, {
    enumerable: false,
    configurable: false,
    writable: false,
    value: async (toolName, params) => {
      if (typeof runner.getToolDefinition !== 'function') {
        throw new Error('getToolDefinition unavailable')
      }
      const definition = runner.getToolDefinition(toolName)
      if (
        definition === undefined ||
        definition === null ||
        typeof definition.execute !== 'function'
      ) {
        throw new Error('tool-definition-unavailable')
      }
      const controller = new AbortController()
      try {
        return await definition.execute(
          `pi-gui-hibernate-lease-${Date.now()}`,
          params,
          controller.signal,
          undefined,
          ctx
        )
      } finally {
        controller.abort()
      }
    }
  })

  return ctx
}

/**
 * @returns {Promise<
 *   | { ok: true, module: { ExtensionRunner: Function } }
 *   | { ok: false, reason: string }
 * >}
 */
async function resolvePiCodingAgentModule() {
  const candidates = []

  // Prefer the Pi CLI package that is actually running this process.
  try {
    if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
      const cliPath = realpathSync(process.argv[1])
      const packageRoot = dirname(dirname(cliPath))
      candidates.push(packageRoot)
    }
  } catch {
    // Ignore path resolution failures and try import-map fallbacks.
  }

  // Optional local install layout via HOME only when set.
  if (typeof process.env.HOME === 'string' && process.env.HOME.length > 0) {
    candidates.push(
      join(process.env.HOME, '.local/lib/node_modules/@earendil-works/pi-coding-agent')
    )
  }

  for (const root of candidates) {
    if (typeof root !== 'string' || root.length === 0) continue
    const packageJsonPath = join(root, 'package.json')
    const indexPath = join(root, 'dist/index.js')
    if (!existsSync(packageJsonPath) || !existsSync(indexPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
      if (
        pkg?.name !== '@earendil-works/pi-coding-agent' &&
        pkg?.name !== '@mariozechner/pi-coding-agent'
      ) {
        continue
      }
      if (pkg.version !== SUPPORTED_PI_CODING_AGENT_VERSION) {
        return { ok: false, reason: 'pi-version-unsupported' }
      }
      const mod = await import(pathToFileURL(indexPath).href)
      if (typeof mod.ExtensionRunner !== 'function') {
        return { ok: false, reason: 'extension-runner-missing' }
      }
      return { ok: true, module: mod }
    } catch {
      // Try next candidate.
    }
  }

  // Final fallback: package name resolution from this module (usually unavailable).
  try {
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('@earendil-works/pi-coding-agent/package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (pkg.version !== SUPPORTED_PI_CODING_AGENT_VERSION) {
      return { ok: false, reason: 'pi-version-unsupported' }
    }
    const mod = await import('@earendil-works/pi-coding-agent')
    if (typeof mod.ExtensionRunner !== 'function') {
      return { ok: false, reason: 'extension-runner-missing' }
    }
    return { ok: true, module: mod }
  } catch {
    return { ok: false, reason: 'pi-module-unresolved' }
  }
}
