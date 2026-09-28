import { readFile, unlink, writeFile } from 'node:fs/promises'

import type { WindowsRemoteHostConfig } from './windows-remote-host-config.ts'
import { parseWindowsRemoteHostConfig } from './windows-remote-host-config.ts'

export type DesktopClientHostConfigStore = {
  save(config: WindowsRemoteHostConfig): Promise<void>
  load(): Promise<WindowsRemoteHostConfig | null>
  clear(): Promise<void>
}

export function createMemoryDesktopClientHostConfigStore(
  initial: WindowsRemoteHostConfig | null = null
): DesktopClientHostConfigStore {
  let config = initial
  return {
    async save(next) {
      config = parseWindowsRemoteHostConfig(next)
    },
    async load() {
      return config
    },
    async clear() {
      config = null
    }
  }
}

export function createFileDesktopClientHostConfigStore(filePath: string): DesktopClientHostConfigStore {
  if (filePath.length === 0) {
    throw new Error('Desktop client host config path must not be empty.')
  }
  return {
    async save(config) {
      const parsed = parseWindowsRemoteHostConfig(config)
      await writeFile(filePath, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600 })
    },
    async load() {
      let text: string
      try {
        text = await readFile(filePath, 'utf8')
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('Desktop client host config file is not valid JSON.')
      }
      return parseWindowsRemoteHostConfig(payload)
    },
    async clear() {
      try {
        await unlink(filePath)
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
