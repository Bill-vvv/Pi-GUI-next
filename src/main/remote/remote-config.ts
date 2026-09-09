import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'

import { deriveRemoteDeviceStorePath } from './remote-device-store.ts'

const REMOTE_TOKEN_FILE_MAX_BYTES = 16 * 1024

export type RemoteDisabledConfig = {
  enabled: false
}

export type RemoteEnabledConfig = {
  enabled: true
  bindHost: string
  port: number
  publicOrigin: string
  publicHost: string
  trustedProxyIp: string
  /** Internal machine secret from PI_GUI_REMOTE_TOKEN_FILE; never accepted from the phone. */
  token: string
  tokenFile: string
  deviceStorePath: string
}

export type RemoteConfig = RemoteDisabledConfig | RemoteEnabledConfig

export async function loadRemoteConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    uid?: number
  } = {}
): Promise<RemoteConfig> {
  if (env.PI_GUI_REMOTE_ENABLED !== '1') {
    return { enabled: false }
  }

  const bindHost = parseExactIpv4(
    requireExactEnv(env, 'PI_GUI_REMOTE_BIND_HOST'),
    'PI_GUI_REMOTE_BIND_HOST'
  )
  if (bindHost === '0.0.0.0') {
    throw new Error('PI_GUI_REMOTE_BIND_HOST must not be the wildcard address 0.0.0.0.')
  }
  const port = parseExactPort(requireExactEnv(env, 'PI_GUI_REMOTE_PORT'))
  const publicOrigin = parseExactHttpsOrigin(requireExactEnv(env, 'PI_GUI_REMOTE_PUBLIC_ORIGIN'))
  const trustedProxyIp = parseExactIpv4(
    requireExactEnv(env, 'PI_GUI_REMOTE_TRUSTED_PROXY'),
    'PI_GUI_REMOTE_TRUSTED_PROXY'
  )
  const tokenFile = requireExactEnv(env, 'PI_GUI_REMOTE_TOKEN_FILE')
  if (!isAbsolute(tokenFile)) {
    throw new Error('PI_GUI_REMOTE_TOKEN_FILE must be an absolute path.')
  }

  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) {
    throw new Error('Remote token ownership can only be verified when process.getuid is available.')
  }

  const token = await readRemoteTokenFile(tokenFile, uid)
  return {
    enabled: true,
    bindHost,
    port,
    publicOrigin,
    publicHost: new URL(publicOrigin).host,
    trustedProxyIp,
    token,
    tokenFile,
    deviceStorePath: deriveRemoteDeviceStorePath(tokenFile)
  }
}

export async function readRemoteTokenFile(
  tokenFile: string,
  uid: number,
  label = 'PI_GUI_REMOTE_TOKEN_FILE'
): Promise<string> {
  let file: FileHandle
  try {
    file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    throw new Error(
      `${label} must be a readable regular non-symlink file: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    const stats = await file.stat()
    if (!stats.isFile()) {
      throw new Error(`${label} must be a regular file owned by the current user.`)
    }
    if (stats.uid !== uid) {
      throw new Error(`${label} must be owned by the current user.`)
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error(`${label} must have mode 0600.`)
    }
    if (stats.size > REMOTE_TOKEN_FILE_MAX_BYTES) {
      throw new Error(`${label} exceeds the bounded size limit.`)
    }

    const token = (await file.readFile({ encoding: 'utf8' })).trim()
    if (token.length < 32 || token.length > 4096) {
      throw new Error(`${label} must contain 32 to 4096 trimmed characters.`)
    }
    if (token.includes('\0') || /[\r\n]/u.test(token)) {
      throw new Error(`${label} must contain one line without NUL bytes.`)
    }
    return token
  } finally {
    await file.close()
  }
}

function requireExactEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${name} must be set to a non-empty exact value when remote is enabled.`)
  }
  return value
}

function parseExactPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new Error('PI_GUI_REMOTE_PORT must be an exact integer port.')
  }
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PI_GUI_REMOTE_PORT must be an exact integer port.')
  }
  return port
}

function parseExactHttpsOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PI_GUI_REMOTE_PUBLIC_ORIGIN must be an exact https origin.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.origin
  ) {
    throw new Error('PI_GUI_REMOTE_PUBLIC_ORIGIN must be an exact https origin.')
  }
  return url.origin
}

function parseExactIpv4(value: string, name: string): string {
  if (isIP(value) !== 4) {
    throw new Error(`${name} must be a single exact IPv4 address.`)
  }
  return value
}
