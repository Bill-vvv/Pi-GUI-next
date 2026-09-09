import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type {
  TailscaleRemoteMode,
  TailscaleRemoteStatus
} from '../../shared/remote-admin-contract.ts'
import { deriveRemoteDeviceStorePath } from './remote-device-store.ts'
import {
  readRemoteTokenFile,
  type RemoteEnabledConfig
} from './remote-config.ts'

const TAILSCALE_REMOTE_CONFIG_VERSION = 1 as const
const TAILSCALE_REMOTE_CONFIG_MAX_BYTES = 4 * 1024
const TAILSCALE_OUTPUT_MAX_BYTES = 1 * 1024 * 1024
const TAILSCALE_ERROR_MAX_CHARS = 8 * 1024
const TAILSCALE_COMMAND_TIMEOUT_MS = 30_000
const TAILSCALE_HTTPS_PORT = 443
const LOOPBACK_HOST = '127.0.0.1'

export type ManagedTailscaleRemoteConfig = {
  mode: Exclude<TailscaleRemoteMode, 'off'>
  publicOrigin: string
  port: number
}

export type PreparedTailscaleRemote = {
  mode: Exclude<TailscaleRemoteMode, 'off'>
  publicOrigin: string
}

export type TailscaleCommandResult = {
  stdout: string
  stderr: string
}

export type RunTailscaleCommand = (
  args: readonly string[]
) => Promise<TailscaleCommandResult>

export type TailscaleRemoteManager = {
  readonly tokenFile: string
  readonly deviceStorePath: string
  getManagedConfig(): ManagedTailscaleRemoteConfig | null
  getStatus(): Promise<TailscaleRemoteStatus>
  prepareEnable(mode: Exclude<TailscaleRemoteMode, 'off'>): Promise<PreparedTailscaleRemote>
  ensureToken(): Promise<string>
  activate(prepared: PreparedTailscaleRemote, port: number): Promise<TailscaleRemoteStatus>
  disableRoute(): Promise<void>
  clearManagedFiles(): Promise<void>
  discardTokenIfUnconfigured(): Promise<void>
}

export async function openTailscaleRemoteManager(options: {
  configPath: string
  tokenFile: string
  uid: number
  runCommand?: RunTailscaleCommand
}): Promise<TailscaleRemoteManager> {
  const configPath = options.configPath
  const tokenFile = options.tokenFile
  const deviceStorePath = deriveRemoteDeviceStorePath(tokenFile)
  const runCommand = options.runCommand ?? runSystemTailscaleCommand
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  let managedConfig = await readManagedConfig(configPath, options.uid)

  const inspect = async (): Promise<TailscaleInspection> => {
    let statusResult: TailscaleCommandResult
    try {
      statusResult = await runCommand(['status', '--json'])
    } catch (error) {
      if (error instanceof TailscaleNotInstalledError) {
        return {
          installed: false,
          backendState: null,
          dnsName: null,
          authUrl: null,
          serveConfig: null
        }
      }
      throw error
    }

    const status = parseTailscaleStatus(statusResult.stdout)
    if (status.backendState !== 'Running' || status.dnsName === null) {
      return {
        installed: true,
        ...status,
        serveConfig: null
      }
    }

    const serveResult = await runCommand(['serve', 'status', '--json'])
    return {
      installed: true,
      ...status,
      serveConfig: parseServeConfig(serveResult.stdout)
    }
  }

  const getStatus = async (): Promise<TailscaleRemoteStatus> => {
    const inspection = await inspect()
    return statusFromInspection(inspection, managedConfig)
  }

  return {
    tokenFile,
    deviceStorePath,
    getManagedConfig() {
      return managedConfig === null ? null : { ...managedConfig }
    },
    getStatus,
    async prepareEnable(mode) {
      assertManagedMode(mode)
      const inspection = await inspect()
      if (!inspection.installed) {
        throw new Error('未检测到 Tailscale。请先安装并登录 Tailscale。')
      }
      if (inspection.backendState !== 'Running') {
        throw new Error(
          `Tailscale 尚未就绪（当前状态：${inspection.backendState ?? 'Unknown'}）。`
        )
      }
      if (inspection.dnsName === null || inspection.serveConfig === null) {
        throw new Error('Tailscale 未提供可用的 MagicDNS 主机名。')
      }

      const publicOrigin = tailscalePublicOrigin(inspection.dnsName)
      if (
        managedConfig !== null &&
        managedConfig.publicOrigin !== publicOrigin
      ) {
        throw new Error('Tailscale 主机名已变化；请先停用现有一键远程配置。')
      }

      const route = inspectManagedRoute(
        inspection.serveConfig,
        inspection.dnsName,
        managedConfig
      )
      if (route.state === 'conflict') {
        throw new Error('Tailscale HTTPS 443 已存在非 Pi GUI 管理的 Serve/Funnel 配置。')
      }

      return { mode, publicOrigin }
    },
    async ensureToken() {
      try {
        const file = await open(
          tokenFile,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600
        )
        try {
          await file.writeFile(`${randomBytes(32).toString('hex')}\n`, 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
        await syncDirectory(dirname(tokenFile))
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
      }
      return await readRemoteTokenFile(tokenFile, options.uid)
    },
    async activate(prepared, port) {
      assertManagedMode(prepared.mode)
      assertExactPort(port)
      const inspection = await inspect()
      if (!inspection.installed || inspection.backendState !== 'Running') {
        throw new Error('Tailscale 在启用过程中变为不可用。')
      }
      if (inspection.dnsName === null || inspection.serveConfig === null) {
        throw new Error('Tailscale 在启用过程中丢失了 MagicDNS 主机名。')
      }
      const currentOrigin = tailscalePublicOrigin(inspection.dnsName)
      if (currentOrigin !== prepared.publicOrigin) {
        throw new Error('Tailscale 主机名在启用过程中发生变化。')
      }

      const route = inspectManagedRoute(
        inspection.serveConfig,
        inspection.dnsName,
        managedConfig
      )
      if (route.state === 'conflict') {
        throw new Error('Tailscale HTTPS 443 在启用过程中出现配置冲突。')
      }

      if (
        route.state === 'active' &&
        managedConfig !== null &&
        managedConfig.mode !== prepared.mode
      ) {
        await runCommand(offArgs(managedConfig.mode))
        await assertRouteOff(runCommand, inspection.dnsName)
      }

      const nextConfig: ManagedTailscaleRemoteConfig = {
        mode: prepared.mode,
        publicOrigin: prepared.publicOrigin,
        port
      }
      await writeManagedConfig(configPath, nextConfig)
      managedConfig = nextConfig

      const target = localTarget(port)
      const current = await inspect()
      if (!current.installed || current.backendState !== 'Running' || current.dnsName === null) {
        throw new Error('Tailscale 在写入一键远程配置后变为不可用。')
      }
      if (current.serveConfig === null) {
        throw new Error('Tailscale Serve 配置在启用前不可用。')
      }
      const currentRoute = inspectManagedRoute(
        current.serveConfig,
        current.dnsName,
        managedConfig
      )
      if (currentRoute.state === 'conflict') {
        throw new Error('Tailscale HTTPS 443 在写入配置后出现冲突。')
      }
      if (currentRoute.state !== 'active') {
        await runCommand(enableArgs(prepared.mode, target))
      }

      const confirmed = await inspect()
      if (
        !confirmed.installed ||
        confirmed.backendState !== 'Running' ||
        confirmed.dnsName === null ||
        confirmed.serveConfig === null
      ) {
        throw new Error('Tailscale 未能确认一键远程配置。')
      }
      const confirmedRoute = inspectManagedRoute(
        confirmed.serveConfig,
        confirmed.dnsName,
        managedConfig
      )
      if (confirmedRoute.state !== 'active') {
        throw new Error('Tailscale 未返回预期的 Pi GUI HTTPS 代理配置。')
      }
      return statusFromInspection(confirmed, managedConfig)
    },
    async disableRoute() {
      if (managedConfig === null) return
      const inspection = await inspect()
      if (!inspection.installed) {
        throw new Error('未检测到 Tailscale，无法安全移除一键远程代理。')
      }
      if (
        inspection.backendState !== 'Running' ||
        inspection.dnsName === null ||
        inspection.serveConfig === null
      ) {
        throw new Error('Tailscale 未运行，无法安全移除一键远程代理。')
      }
      const route = inspectManagedRoute(
        inspection.serveConfig,
        inspection.dnsName,
        managedConfig
      )
      if (route.state === 'conflict') {
        throw new Error('Tailscale HTTPS 443 已被修改；Pi GUI 不会覆盖或删除未知配置。')
      }
      if (route.state === 'active') {
        await runCommand(offArgs(managedConfig.mode))
        await assertRouteOff(runCommand, inspection.dnsName)
      }
    },
    async clearManagedFiles() {
      await removeFile(configPath)
      await removeFile(tokenFile)
      managedConfig = null
    },
    async discardTokenIfUnconfigured() {
      if (managedConfig !== null) return
      await removeFile(tokenFile)
    }
  }
}

export function createTailscaleRemoteGatewayConfig(options: {
  publicOrigin: string
  port: number
  token: string
  tokenFile: string
}): RemoteEnabledConfig {
  assertExactHttpsOrigin(options.publicOrigin)
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('Tailscale Remote gateway port must be between 0 and 65535.')
  }
  return {
    enabled: true,
    bindHost: LOOPBACK_HOST,
    port: options.port,
    publicOrigin: options.publicOrigin,
    publicHost: new URL(options.publicOrigin).host,
    trustedProxyIp: LOOPBACK_HOST,
    token: options.token,
    tokenFile: options.tokenFile,
    deviceStorePath: deriveRemoteDeviceStorePath(options.tokenFile)
  }
}

function statusFromInspection(
  inspection: TailscaleInspection,
  managedConfig: ManagedTailscaleRemoteConfig | null
): TailscaleRemoteStatus {
  let routeState: TailscaleRemoteStatus['routeState'] = 'unavailable'
  if (
    inspection.installed &&
    inspection.backendState === 'Running' &&
    inspection.dnsName !== null &&
    inspection.serveConfig !== null
  ) {
    routeState = inspectManagedRoute(
      inspection.serveConfig,
      inspection.dnsName,
      managedConfig
    ).state
  }
  return {
    installed: inspection.installed,
    backendState: inspection.backendState,
    dnsName: inspection.dnsName,
    authUrl: inspection.authUrl,
    managedMode: managedConfig?.mode ?? 'off',
    routeState,
    publicOrigin: managedConfig?.publicOrigin ?? null
  }
}

type TailscaleInspection = {
  installed: boolean
  backendState: string | null
  dnsName: string | null
  authUrl: string | null
  serveConfig: TailscaleServeConfig | null
}

type ParsedTailscaleStatus = Omit<TailscaleInspection, 'installed' | 'serveConfig'>

type TailscaleServeConfig = {
  TCP?: Record<string, unknown>
  Web?: Record<string, unknown>
  Services?: Record<string, unknown>
  AllowFunnel?: Record<string, unknown>
  Foreground?: Record<string, unknown>
}

type ManagedRouteInspection = {
  state: TailscaleRemoteStatus['routeState']
}

function parseTailscaleStatus(raw: string): ParsedTailscaleStatus {
  const value = parseBoundedJson(raw, 'Tailscale status')
  if (!isRecord(value)) {
    throw new Error('Tailscale status must be a JSON object.')
  }
  const backendState = value.BackendState
  if (typeof backendState !== 'string' || backendState.length < 1 || backendState.length > 64) {
    throw new Error('Tailscale status.BackendState is invalid.')
  }

  let dnsName: string | null = null
  if (value.Self !== undefined && value.Self !== null) {
    if (!isRecord(value.Self)) throw new Error('Tailscale status.Self is invalid.')
    if (value.Self.DNSName !== undefined) {
      if (typeof value.Self.DNSName !== 'string') {
        throw new Error('Tailscale status.Self.DNSName is invalid.')
      }
      dnsName = normalizeDnsName(value.Self.DNSName)
    }
  }

  let authUrl: string | null = null
  if (value.AuthURL !== undefined && value.AuthURL !== '') {
    if (typeof value.AuthURL !== 'string' || value.AuthURL.length > 2048) {
      throw new Error('Tailscale status.AuthURL is invalid.')
    }
    const parsed = new URL(value.AuthURL)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Tailscale status.AuthURL must use HTTP or HTTPS.')
    }
    authUrl = parsed.toString()
  }

  return { backendState, dnsName, authUrl }
}

function parseServeConfig(raw: string): TailscaleServeConfig {
  const value = parseBoundedJson(raw, 'Tailscale Serve config')
  if (value === null) return {}
  if (!isRecord(value)) {
    throw new Error('Tailscale Serve config must be a JSON object.')
  }
  for (const key of ['TCP', 'Web', 'Services', 'AllowFunnel', 'Foreground'] as const) {
    const member = value[key]
    if (member !== undefined && !isRecord(member)) {
      throw new Error(`Tailscale Serve config.${key} is invalid.`)
    }
  }
  return value as TailscaleServeConfig
}

function inspectManagedRoute(
  config: TailscaleServeConfig,
  dnsName: string,
  managedConfig: ManagedTailscaleRemoteConfig | null
): ManagedRouteInspection {
  const hostPort = `${dnsName}:${TAILSCALE_HTTPS_PORT}`
  const tcp = config.TCP?.[String(TAILSCALE_HTTPS_PORT)]
  const web = config.Web?.[hostPort]
  const allowFunnel = config.AllowFunnel?.[hostPort]
  const slotPresent = tcp !== undefined || web !== undefined || allowFunnel !== undefined
  if (!slotPresent) {
    return { state: managedConfig === null ? 'off' : 'unavailable' }
  }
  if (managedConfig === null) return { state: 'conflict' }
  if (!isRecord(tcp) || tcp.HTTPS !== true || Object.keys(tcp).some((key) => key !== 'HTTPS')) {
    return { state: 'conflict' }
  }
  if (!isRecord(web) || !isRecord(web.Handlers)) return { state: 'conflict' }
  const handlers = web.Handlers
  if (Object.keys(handlers).length !== 1 || !isRecord(handlers['/'])) {
    return { state: 'conflict' }
  }
  const handler = handlers['/']
  if (Object.keys(handler).some((key) => key !== 'Proxy')) return { state: 'conflict' }
  if (typeof handler.Proxy !== 'string' || !sameProxyTarget(handler.Proxy, localTarget(managedConfig.port))) {
    return { state: 'conflict' }
  }
  const funnelEnabled = allowFunnel === true
  if (managedConfig.mode === 'funnel' ? !funnelEnabled : funnelEnabled) {
    return { state: 'conflict' }
  }
  return { state: 'active' }
}

async function assertRouteOff(
  runCommand: RunTailscaleCommand,
  dnsName: string
): Promise<void> {
  const result = await runCommand(['serve', 'status', '--json'])
  const config = parseServeConfig(result.stdout)
  const route = inspectManagedRoute(config, dnsName, null)
  if (route.state !== 'off') {
    throw new Error('Tailscale HTTPS 443 remained configured after the disable command.')
  }
}

function enableArgs(
  mode: Exclude<TailscaleRemoteMode, 'off'>,
  target: string
): string[] {
  return [mode, '--bg', '--yes', `--https=${TAILSCALE_HTTPS_PORT}`, target]
}

function offArgs(mode: Exclude<TailscaleRemoteMode, 'off'>): string[] {
  return [mode, `--https=${TAILSCALE_HTTPS_PORT}`, 'off']
}

function localTarget(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`
}

function sameProxyTarget(actual: string, expected: string): boolean {
  return actual === expected || actual === `${expected}/`
}

function tailscalePublicOrigin(dnsName: string): string {
  return `https://${dnsName}`
}

function normalizeDnsName(value: string): string | null {
  const normalized = value.endsWith('.') ? value.slice(0, -1) : value
  if (normalized.length === 0) return null
  if (
    normalized.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(normalized) ||
    normalized.includes('..')
  ) {
    throw new Error('Tailscale status.Self.DNSName is invalid.')
  }
  return normalized.toLowerCase()
}

function assertManagedMode(mode: TailscaleRemoteMode): asserts mode is Exclude<TailscaleRemoteMode, 'off'> {
  if (mode !== 'serve' && mode !== 'funnel') {
    throw new Error('Tailscale Remote mode must be serve or funnel.')
  }
}

function assertExactPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Tailscale Remote port must be an integer between 1 and 65535.')
  }
}

function assertExactHttpsOrigin(value: string): void {
  const parsed = new URL(value)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    throw new Error('Tailscale Remote public origin must be an exact HTTPS origin.')
  }
}

async function readManagedConfig(
  configPath: string,
  uid: number
): Promise<ManagedTailscaleRemoteConfig | null> {
  let file: FileHandle
  try {
    file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNotFound(error)) return null
    throw new Error(`Tailscale Remote config must be a readable non-symlink file: ${errorMessage(error)}`)
  }
  try {
    const stats = await file.stat()
    if (!stats.isFile() || stats.uid !== uid) {
      throw new Error('Tailscale Remote config must be a regular file owned by the current user.')
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error('Tailscale Remote config must have mode 0600.')
    }
    if (stats.size > TAILSCALE_REMOTE_CONFIG_MAX_BYTES) {
      throw new Error('Tailscale Remote config exceeds its size limit.')
    }
    return parseManagedConfig(JSON.parse(await file.readFile({ encoding: 'utf8' })) as unknown)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Tailscale Remote config must contain valid JSON.')
    }
    throw error
  } finally {
    await file.close()
  }
}

function parseManagedConfig(value: unknown): ManagedTailscaleRemoteConfig {
  if (!isRecord(value)) throw new Error('Tailscale Remote config schema is invalid.')
  const keys = Object.keys(value)
  if (
    keys.length !== 4 ||
    !keys.includes('version') ||
    !keys.includes('mode') ||
    !keys.includes('publicOrigin') ||
    !keys.includes('port')
  ) {
    throw new Error('Tailscale Remote config schema is invalid.')
  }
  if (value.version !== TAILSCALE_REMOTE_CONFIG_VERSION) {
    throw new Error('Tailscale Remote config version is unsupported.')
  }
  const mode = value.mode
  assertManagedMode(mode as TailscaleRemoteMode)
  if (typeof value.publicOrigin !== 'string') {
    throw new Error('Tailscale Remote config publicOrigin is invalid.')
  }
  assertExactHttpsOrigin(value.publicOrigin)
  const port = value.port
  assertExactPort(port as number)
  return {
    mode: mode as Exclude<TailscaleRemoteMode, 'off'>,
    publicOrigin: value.publicOrigin,
    port: port as number
  }
}

async function writeManagedConfig(
  configPath: string,
  config: ManagedTailscaleRemoteConfig
): Promise<void> {
  parseManagedConfig({ version: TAILSCALE_REMOTE_CONFIG_VERSION, ...config })
  const directory = dirname(configPath)
  const temporaryPath = join(
    directory,
    `.${basename(configPath)}.${randomBytes(8).toString('hex')}.tmp`
  )
  let file: FileHandle | null = null
  try {
    file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    await file.writeFile(`${JSON.stringify({
      version: TAILSCALE_REMOTE_CONFIG_VERSION,
      ...config
    })}\n`, 'utf8')
    await file.sync()
    await file.close()
    file = null
    await rename(temporaryPath, configPath)
    await syncDirectory(directory)
  } catch (error) {
    if (file !== null) await file.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  await syncDirectory(dirname(path))
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function runSystemTailscaleCommand(
  args: readonly string[]
): Promise<TailscaleCommandResult> {
  return await new Promise<TailscaleCommandResult>((resolve, reject) => {
    execFile('tailscale', [...args], {
      encoding: 'utf8',
      maxBuffer: TAILSCALE_OUTPUT_MAX_BYTES,
      timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error !== null) {
        if (isNotFound(error)) {
          reject(new TailscaleNotInstalledError())
          return
        }
        const detail = boundedError(stderr || error.message)
        reject(new Error(`Tailscale command failed${detail.length > 0 ? `: ${detail}` : '.'}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

class TailscaleNotInstalledError extends Error {
  constructor() {
    super('Tailscale executable was not found.')
    this.name = 'TailscaleNotInstalledError'
  }
}

function parseBoundedJson(raw: string, label: string): unknown {
  if (Buffer.byteLength(raw, 'utf8') > TAILSCALE_OUTPUT_MAX_BYTES) {
    throw new Error(`${label} exceeds its size limit.`)
  }
  if (raw.trim().length === 0) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${label} must contain valid JSON.`)
  }
}

function boundedError(value: string): string {
  const trimmed = value.trim()
  return trimmed.length <= TAILSCALE_ERROR_MAX_CHARS
    ? trimmed
    : trimmed.slice(trimmed.length - TAILSCALE_ERROR_MAX_CHARS)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
