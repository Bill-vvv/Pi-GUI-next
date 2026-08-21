import { AsyncLocalStorage } from 'node:async_hooks'

type ScopedEnvironmentValues = Map<string, string | undefined>

const environmentScope = new AsyncLocalStorage<ScopedEnvironmentValues>()

let originalEnvironment: NodeJS.ProcessEnv | null = null
let scopedEnvironmentProxy: NodeJS.ProcessEnv | null = null
let ownerCount = 0

function scopedValue(property: PropertyKey): { scoped: boolean, value: string | undefined } {
  if (typeof property !== 'string') return { scoped: false, value: undefined }
  const values = environmentScope.getStore()
  if (values === undefined || !values.has(property)) return { scoped: false, value: undefined }
  return { scoped: true, value: values.get(property) }
}

function installScopedEnvironment(): void {
  if (scopedEnvironmentProxy !== null) return

  const target = process.env
  const proxy = new Proxy(target, {
    get(environment, property, receiver) {
      const scoped = scopedValue(property)
      return scoped.scoped ? scoped.value : Reflect.get(environment, property, receiver)
    },
    has(environment, property) {
      const scoped = scopedValue(property)
      return scoped.scoped ? scoped.value !== undefined : Reflect.has(environment, property)
    },
    ownKeys(environment) {
      const keys = new Set(Reflect.ownKeys(environment))
      const values = environmentScope.getStore()
      if (values !== undefined) {
        for (const [key, value] of values) {
          if (value === undefined) keys.delete(key)
          else keys.add(key)
        }
      }
      return [...keys]
    },
    getOwnPropertyDescriptor(environment, property) {
      const scoped = scopedValue(property)
      if (!scoped.scoped) return Reflect.getOwnPropertyDescriptor(environment, property)
      if (scoped.value === undefined) return undefined
      return {
        configurable: true,
        enumerable: true,
        value: scoped.value,
        writable: true
      }
    },
    set(environment, property, value, receiver) {
      if (typeof property === 'string') {
        const values = environmentScope.getStore()
        if (values !== undefined) {
          values.set(property, String(value))
          return true
        }
      }
      return Reflect.set(environment, property, String(value), receiver)
    },
    deleteProperty(environment, property) {
      if (typeof property === 'string') {
        const values = environmentScope.getStore()
        if (values !== undefined) {
          values.set(property, undefined)
          return true
        }
      }
      return Reflect.deleteProperty(environment, property)
    }
  }) as NodeJS.ProcessEnv

  originalEnvironment = target
  scopedEnvironmentProxy = proxy
  process.env = proxy
}

function uninstallScopedEnvironment(): void {
  if (scopedEnvironmentProxy === null || originalEnvironment === null) return
  if (process.env !== scopedEnvironmentProxy) {
    throw new Error('Scoped Pi environment ownership changed before disposal.')
  }
  process.env = originalEnvironment
  originalEnvironment = null
  scopedEnvironmentProxy = null
}

export type SharedPiEnvironmentOverrides = Readonly<Record<string, string | undefined>>

/**
 * Process-wide adapter that gives each asynchronous Pi Session its own environment view.
 * The proxy is installed once while at least one SharedPiHost owns it; reads and writes
 * inside a scope stay in that AsyncLocalStorage lineage instead of mutating other Sessions.
 */
export class SharedPiProcessEnvironment {
  private disposed = false

  constructor() {
    installScopedEnvironment()
    ownerCount += 1
  }

  run<T>(overrides: SharedPiEnvironmentOverrides, operation: () => T): T {
    if (this.disposed) throw new Error('Shared Pi process environment is disposed.')
    const values = new Map(environmentScope.getStore())
    for (const [key, value] of Object.entries(overrides)) values.set(key, value)
    return environmentScope.run(values, operation)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ownerCount -= 1
    if (ownerCount === 0) uninstallScopedEnvironment()
  }
}
