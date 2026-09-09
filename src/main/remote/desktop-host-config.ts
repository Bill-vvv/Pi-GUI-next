import { isAbsolute } from 'node:path'

import { readRemoteTokenFile } from './remote-config.ts'

export const DESKTOP_HOST_BIND_HOST = '127.0.0.1' as const

export type DesktopHostDisabledConfig = {
  enabled: false
}

export type DesktopHostEnabledConfig = {
  enabled: true
  bindHost: typeof DESKTOP_HOST_BIND_HOST
  port: number
  token: string
  tokenFile: string
  deviceStorePath: string
}

export type DesktopHostConfig = DesktopHostDisabledConfig | DesktopHostEnabledConfig

export async function loadDesktopHostConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { uid?: number } = {}
): Promise<DesktopHostConfig> {
  if (env.PI_GUI_DESKTOP_HOST_ENABLED !== '1') return { enabled: false }

  const port = parseExactPort(requireExactEnv(env, 'PI_GUI_DESKTOP_HOST_PORT'))
  const tokenFile = requireExactEnv(env, 'PI_GUI_DESKTOP_HOST_TOKEN_FILE')
  if (!isAbsolute(tokenFile)) {
    throw new Error('PI_GUI_DESKTOP_HOST_TOKEN_FILE must be an absolute path.')
  }

  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) {
    throw new Error(
      'Desktop Host token ownership can only be verified when process.getuid is available.'
    )
  }

  const token = await readRemoteTokenFile(
    tokenFile,
    uid,
    'PI_GUI_DESKTOP_HOST_TOKEN_FILE'
  )
  return {
    enabled: true,
    bindHost: DESKTOP_HOST_BIND_HOST,
    port,
    token,
    tokenFile,
    deviceStorePath: `${tokenFile}.desktop-device`
  }
}

function requireExactEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${name} must be set to a non-empty exact value when Desktop Host is enabled.`)
  }
  return value
}

function parseExactPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new Error('PI_GUI_DESKTOP_HOST_PORT must be an exact integer port.')
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PI_GUI_DESKTOP_HOST_PORT must be an exact integer port.')
  }
  return port
}
