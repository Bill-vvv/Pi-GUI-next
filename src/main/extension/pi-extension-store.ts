import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { lock } from 'proper-lockfile'

import type { KernelExtensionDescriptor } from '../../shared/kernel-contract.ts'

type Settings = Record<string, unknown>

export class PiExtensionStore {
  private readonly settingsPath: string

  constructor(agentDir = resolvePiAgentDir()) {
    this.settingsPath = join(agentDir, 'settings.json')
  }

  async list(): Promise<KernelExtensionDescriptor[]> {
    return this.withSettingsLock(async (settings) => describeExtensions(readExtensionPaths(settings)))
  }

  async install(selectedPath: string): Promise<KernelExtensionDescriptor[]> {
    const extensionPath = await validateSelectedExtensionPath(selectedPath)
    return this.update((paths) => paths.includes(extensionPath) ? paths : [...paths, extensionPath])
  }

  async remove(extensionPath: string): Promise<KernelExtensionDescriptor[]> {
    const path = validateConfiguredPath(extensionPath)
    return this.update((paths) => paths.filter((candidate) => candidate !== path))
  }

  private async update(
    transform: (paths: string[]) => string[]
  ): Promise<KernelExtensionDescriptor[]> {
    return this.withSettingsLock(async (settings) => {
      const currentPaths = readExtensionPaths(settings)
      const nextPaths = transform(currentPaths)
      if (!samePaths(currentPaths, nextPaths)) {
        settings.extensions = nextPaths
        await writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      }
      return describeExtensions(nextPaths)
    })
  }

  private async withSettingsLock<T>(operation: (settings: Settings) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.settingsPath), { recursive: true })
    const release = await lock(this.settingsPath, {
      realpath: false,
      retries: {
        retries: 9,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20
      }
    })

    try {
      return await operation(await readSettings(this.settingsPath))
    } finally {
      await release()
    }
  }
}

export function resolvePiAgentDir(
  configuredDir = process.env.PI_CODING_AGENT_DIR,
  homeDir = homedir()
): string {
  if (configuredDir === undefined || configuredDir.length === 0) {
    return join(homeDir, '.pi', 'agent')
  }
  if (configuredDir === '~') return homeDir
  if (configuredDir.startsWith('~/')) return resolve(homeDir, configuredDir.slice(2))
  return resolve(configuredDir)
}

async function validateSelectedExtensionPath(selectedPath: string): Promise<string> {
  const path = validateConfiguredPath(selectedPath)
  const canonicalPath = await realpath(path)
  const pathStats = await stat(canonicalPath)
  if (pathStats.isDirectory()) return canonicalPath
  if (pathStats.isFile() && isExtensionFile(canonicalPath)) return canonicalPath
  throw new Error('Pi Extension 必须是 .ts/.js 文件或目录。')
}

function validateConfiguredPath(extensionPath: string): string {
  if (extensionPath.length === 0 || extensionPath.trim() !== extensionPath || /[\0\r\n]/u.test(extensionPath)) {
    throw new Error('Pi Extension 路径无效。')
  }
  return extensionPath
}

async function readSettings(settingsPath: string): Promise<Settings> {
  let raw: string
  try {
    raw = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return {}
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Pi 设置文件不是有效的 JSON：${settingsPath}`)
  }
  if (!isRecord(parsed)) throw new Error(`Pi 设置文件必须包含 JSON 对象：${settingsPath}`)
  return parsed
}

function readExtensionPaths(settings: Settings): string[] {
  const value = settings.extensions
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((path) => typeof path !== 'string')) {
    throw new Error('Pi 设置中的 extensions 必须是字符串数组。')
  }
  return [...value]
}

function describeExtensions(paths: readonly string[]): KernelExtensionDescriptor[] {
  return paths.map((path) => ({
    path,
    name: extensionName(path)
  }))
}

function extensionName(path: string): string {
  const filename = basename(path)
  return isExtensionFile(filename) ? basename(filename, extname(filename)) : filename || path
}

function isExtensionFile(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension === '.ts' || extension === '.js'
}

function samePaths(current: readonly string[], next: readonly string[]): boolean {
  return current.length === next.length && current.every((path, index) => path === next[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
