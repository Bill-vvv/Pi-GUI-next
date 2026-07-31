import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { lock } from 'proper-lockfile'

import type {
  KernelInstalledPackage,
  KernelPiDevCatalog,
  KernelPiDevPackage
} from '../../shared/kernel-contract.ts'
import { resolvePiExecutable } from '../runtime/pi-executable.ts'
import { resolvePiAgentDir } from './pi-extension-store.ts'

const CATALOG_URL = 'https://pi.dev/packages'
const DEFAULT_FETCH_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_PACKAGES = 50
const COMMAND_TIMEOUT_MS = 180_000
const MAX_COMMAND_OUTPUT_BYTES = 16_384
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024

export interface PiDevCommandOptions {
  cwd: string
  shell: false
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
}

export type PiDevCommandRunner = (
  executable: string,
  args: readonly string[],
  options: PiDevCommandOptions
) => Promise<void>

export interface PiDevPackageServiceOptions {
  agentDir?: string
  piExecutablePath?: string
  fetch?: typeof globalThis.fetch
  commandRunner?: PiDevCommandRunner
  fetchTimeoutMs?: number
}

export class PiDevPackageService {
  private readonly agentDir: string
  private readonly piExecutablePath: string | undefined
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly commandRunner: PiDevCommandRunner
  private readonly fetchTimeoutMs: number

  constructor(options: PiDevPackageServiceOptions = {}) {
    this.agentDir = resolve(options.agentDir ?? resolvePiAgentDir())
    this.piExecutablePath = options.piExecutablePath
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.commandRunner = options.commandRunner ?? runPiCommand
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS

    if (!Number.isFinite(this.fetchTimeoutMs) || this.fetchTimeoutMs <= 0) {
      throw new Error('Pi package catalog timeout must be a positive number of milliseconds.')
    }
  }

  async catalog(name?: string, type?: 'extension'): Promise<KernelPiDevCatalog> {
    if (name !== undefined && (name.trim() !== name || name.length > 100 || /[\0\r\n]/u.test(name))) {
      throw new Error('Pi package catalog name filter is invalid.')
    }

    const url = new URL(CATALOG_URL)
    if (name !== undefined && name.length > 0) url.searchParams.set('name', name)
    if (type !== undefined) url.searchParams.set('type', type)

    const html = await this.fetchCatalogHtml(url)
    const installedNames = await readInstalledPackageNames(join(this.agentDir, 'settings.json'))
    const parsed = parseCatalogHtml(html)

    return {
      packages: parsed.packages.map((item) => ({
        ...item,
        installed: installedNames.has(item.name)
      })),
      total: parsed.total
    }
  }

  async install(name: string): Promise<void> {
    this.validateInstallName(name)
    await this.runPackageCommand(['install', `npm:${name}`, '--no-approve'])
  }

  validateInstallName(name: string): void {
    assertValidNpmPackageName(name)
  }

  async list(): Promise<KernelInstalledPackage[]> {
    return readInstalledPackages(join(this.agentDir, 'settings.json'))
  }

  async setExtensionEnabled(
    source: string,
    enabled: boolean
  ): Promise<KernelInstalledPackage[]> {
    return this.updateExtensionEnabled(
      enabled,
      (packages) => findConfiguredPackageIndex(packages, source)
    )
  }

  async setPackageExtensionEnabled(
    packageName: string,
    enabled: boolean
  ): Promise<KernelInstalledPackage[]> {
    assertValidNpmPackageName(packageName)
    return this.updateExtensionEnabled(enabled, async (packages, settingsDirectory) => {
      const descriptions = await describeInstalledPackages(packages, settingsDirectory)
      const matches = descriptions.flatMap((pkg, index) =>
        pkg.packageName === packageName ? [index] : []
      )
      if (matches.length === 0) return -1
      if (matches.length > 1) {
        throw new Error('Pi package source must resolve uniquely by package name.')
      }
      return matches[0]!
    })
  }

  private async updateExtensionEnabled(
    enabled: boolean,
    findIndex: (
      packages: Array<string | Record<string, unknown>>,
      settingsDirectory: string
    ) => number | Promise<number>
  ): Promise<KernelInstalledPackage[]> {
    const settingsPath = join(this.agentDir, 'settings.json')
    const settingsDirectory = dirname(settingsPath)
    await mkdir(settingsDirectory, { recursive: true })
    const release = await lock(settingsPath, {
      realpath: false,
      retries: {
        retries: 9,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20
      }
    })
    try {
      const settings = await readSettings(settingsPath)
      const packages = readPackageSources(settings)
      const index = await findIndex(packages, settingsDirectory)
      if (index === -1) throw new Error('Pi package is not present in user settings.')
      const current = packages[index]!
      if (enabled) {
        if (typeof current === 'string') {
          return describeInstalledPackages(packages, settingsDirectory)
        }
        const next = { ...current }
        delete next.extensions
        if (next.autoload === false) delete next.autoload
        packages[index] = next
      } else {
        packages[index] = typeof current === 'string'
          ? { source: current, extensions: [] }
          : { ...current, extensions: [] }
      }
      settings.packages = packages
      await writeSettingsAtomically(settingsPath, settings)
      return describeInstalledPackages(packages, settingsDirectory)
    } finally {
      await release()
    }
  }

  async remove(source: string): Promise<void> {
    const configuredSource = await this.resolveConfiguredSource(source)
    await this.runPackageCommand(['remove', configuredSource, '--no-approve'])
  }

  async update(source?: string): Promise<void> {
    if (source === undefined) {
      await this.runPackageCommand(['update', '--extensions', '--no-approve'])
      return
    }
    const configuredSource = await this.resolveConfiguredSource(source)
    await this.runPackageCommand(['update', '--extension', configuredSource, '--no-approve'])
  }

  private async fetchCatalogHtml(url: URL): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'text/html' }
      })
      if (!response.ok) {
        throw new Error(`Pi package catalog request failed with HTTP ${response.status}.`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!/^text\/html(?:\s*;|$)/iu.test(contentType)) {
        throw new Error('Pi package catalog returned a non-HTML response.')
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
        throw new Error(`Pi package catalog response exceeds ${MAX_RESPONSE_BYTES} bytes.`)
      }

      return await readBoundedResponse(response, MAX_RESPONSE_BYTES)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Pi package catalog request timed out after ${this.fetchTimeoutMs} ms.`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async resolveConfiguredSource(source: string): Promise<string> {
    const packages = await this.list()
    const exact = packages.find((pkg) => pkg.source === source)
    if (exact !== undefined) return exact.source

    const npmName = packageNameFromNpmSource(source)
    const npmMatch = npmName === undefined
      ? undefined
      : packages.find((pkg) => packageNameFromNpmSource(pkg.source) === npmName)
    if (npmMatch !== undefined) return npmMatch.source

    throw new Error('Pi package is not present in user settings.')
  }

  private async runPackageCommand(args: readonly string[]): Promise<void> {
    await mkdir(this.agentDir, { recursive: true })
    const executable = resolvePiExecutable({ explicitPath: this.piExecutablePath })

    try {
      await this.commandRunner(executable, args, {
        cwd: this.agentDir,
        shell: false,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: this.agentDir,
          GIT_TERMINAL_PROMPT: '0'
        },
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES
      })
    } catch {
      throw new Error('Pi package command failed.')
    }
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) throw new Error('Pi package catalog returned an empty response.')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    byteLength += value.byteLength
    if (byteLength > maximumBytes) {
      await reader.cancel()
      throw new Error(`Pi package catalog response exceeds ${maximumBytes} bytes.`)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function parseCatalogHtml(html: string): Omit<KernelPiDevCatalog, 'packages'> & {
  packages: Array<Omit<KernelPiDevPackage, 'installed'>>
} {
  const articles = [...html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article\s*>/giu)]
    .filter((match) => /\bdata-package-card\s*=\s*(?:"true"|'true'|true)(?=\s|$)/iu.test(match[1] ?? ''))

  if (articles.length === 0) {
    if (
      /\bclass\s*=\s*(?:"[^"]*\bpackages-empty\b[^"]*"|'[^']*\bpackages-empty\b[^']*')/iu.test(html) &&
      /\bclass\s*=\s*(?:"[^"]*\bpackages-count\b[^"]*"|'[^']*\bpackages-count\b[^']*')[^>]*>\s*0\s*\//iu.test(html)
    ) return { packages: [], total: 0 }
    throw new Error('Pi package catalog structure changed: no package cards were found.')
  }

  const packages = articles.slice(0, MAX_PACKAGES).map((match) =>
    parsePackageCard(match[1] ?? '', match[2] ?? '')
  )
  return { packages, total: parseCatalogTotal(html, packages.length) }
}

function parsePackageCard(
  cardAttributes: string,
  cardHtml: string
): Omit<KernelPiDevPackage, 'installed'> {
  const links = [...cardHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)]
  const detailLink = links.find((match) => {
    const href = readAttribute(match[1] ?? '', 'href')
    return href !== undefined && /^\/packages\/(?:@[^/?#]+\/)?[^/?#]+(?:[?#].*)?$/u.test(href)
  })
  if (detailLink === undefined) throw new Error('Pi package catalog card is missing its detail link.')

  const href = readAttribute(detailLink[1] ?? '', 'href') as string
  const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/iu.exec(cardHtml)
  const name = readAttribute(cardAttributes, 'data-package-name') ??
    normalizeText(heading?.[1] ?? detailLink[2] ?? '')
  assertValidNpmPackageName(name)

  const descriptionElement = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/iu.exec(cardHtml)
  const descriptionAttribute = findDataAttribute(cardHtml, 'data-package-description')
  const description = normalizeText(descriptionAttribute ?? descriptionElement?.[1] ?? '')
  if (description.length === 0) throw new Error(`Pi package catalog card for ${name} is missing its description.`)

  const downloadsAttribute = readAttribute(cardAttributes, 'data-package-downloads') ??
    findDataAttribute(cardHtml, 'data-downloads')
  const cardText = normalizeText(cardHtml)
  const downloadsMatch = /\b([0-9][0-9,.]*(?:\.[0-9]+)?[KMB]?)\s*\/\s*mo\b/iu.exec(cardText)
  const downloads = downloadsAttribute === undefined
    ? normalizeText(downloadsMatch?.[0] ?? '')
    : `${Number(downloadsAttribute).toLocaleString('en-US')}/mo`
  if (downloads.length === 0) throw new Error(`Pi package catalog card for ${name} is missing its downloads count.`)

  return {
    name,
    description,
    downloads,
    detailUrl: new URL(href, CATALOG_URL).toString()
  }
}

function parseCatalogTotal(html: string, fallback: number): number {
  const attribute = findDataAttribute(html, 'data-total')
  const pagination = /\b[0-9][0-9,]*\s*-\s*[0-9][0-9,]*\s*\/\s*([0-9][0-9,]*)\b/u.exec(normalizeText(html))
  const raw = attribute ?? pagination?.[1]
  if (raw === undefined) return fallback
  const total = Number(raw.replaceAll(',', ''))
  return Number.isSafeInteger(total) && total >= fallback ? total : fallback
}

async function readInstalledPackages(settingsPath: string): Promise<KernelInstalledPackage[]> {
  let settings: Record<string, unknown>
  try {
    settings = await readSettings(settingsPath)
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
  return describeInstalledPackages(readPackageSources(settings), dirname(settingsPath))
}

function readPackageSources(settings: Record<string, unknown>): Array<string | Record<string, unknown>> {
  if (settings.packages === undefined) return []
  if (!Array.isArray(settings.packages)) throw new Error('Pi settings packages must be an array.')
  for (const item of settings.packages) {
    const source = typeof item === 'string'
      ? item
      : isRecord(item) && typeof item.source === 'string' ? item.source : undefined
    if (source === undefined) throw new Error('Pi settings packages entries must be strings or objects with a source string.')
    if (source.length === 0 || source.trim() !== source || /[\0\r\n]/u.test(source)) {
      throw new Error('Pi settings package source is invalid.')
    }
    if (typeof item !== 'string') {
      if (item.autoload !== undefined && typeof item.autoload !== 'boolean') {
        throw new Error('Pi settings package autoload must be a boolean.')
      }
      for (const field of ['extensions', 'skills', 'prompts', 'themes'] as const) {
        if (
          item[field] !== undefined &&
          (!Array.isArray(item[field]) || !item[field].every(isValidPackageFilterEntry))
        ) {
          throw new Error(`Pi settings package ${field} must be an array of non-empty strings.`)
        }
      }
    }
  }
  return settings.packages as Array<string | Record<string, unknown>>
}

async function describeInstalledPackages(
  packages: readonly (string | Record<string, unknown>)[],
  settingsDirectory: string
): Promise<KernelInstalledPackage[]> {
  return Promise.all(packages.map(async (item) => {
    const source = typeof item === 'string' ? item : item.source as string
    return {
      source,
      packageName: await packageNameFromSource(source, settingsDirectory),
      filtered: typeof item !== 'string',
      extensionEnabled: typeof item === 'string' || (
        Array.isArray(item.extensions)
          ? item.extensions.length > 0
          : item.autoload !== false
      )
    }
  }))
}

function findConfiguredPackageIndex(
  packages: readonly (string | Record<string, unknown>)[],
  source: string
): number {
  const exact = packages.findIndex((item) =>
    (typeof item === 'string' ? item : item.source) === source
  )
  if (exact !== -1) return exact
  const npmName = packageNameFromNpmSource(source)
  return npmName === undefined
    ? -1
    : packages.findIndex((item) =>
        packageNameFromNpmSource(typeof item === 'string' ? item : item.source as string) === npmName
      )
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(settingsPath, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return {}
    throw error
  }
  let settings: unknown
  try {
    settings = JSON.parse(raw)
  } catch {
    throw new Error(`Pi settings file is not valid JSON: ${settingsPath}`)
  }
  if (!isRecord(settings)) throw new Error(`Pi settings file must contain a JSON object: ${settingsPath}`)
  return settings
}

async function writeSettingsAtomically(
  settingsPath: string,
  settings: Record<string, unknown>
): Promise<void> {
  const temporaryPath = `${settingsPath}.tmp-${randomUUID()}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600
    })
    await rename(temporaryPath, settingsPath)
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingPathError(error)) throw error
    })
  }
}

async function readInstalledPackageNames(settingsPath: string): Promise<Set<string>> {
  const packages = await readInstalledPackages(settingsPath)
  return new Set(packages.flatMap(({ packageName }) =>
    packageName === null ? [] : [packageName]
  ))
}

async function packageNameFromSource(
  source: string,
  settingsDirectory: string
): Promise<string | null> {
  const npmPackageName = packageNameFromNpmSource(source)
  if (npmPackageName !== undefined) return npmPackageName
  if (!isLocalPackageSource(source)) return null
  const packageDirectory = source.startsWith('~/')
    ? resolve(homedir(), source.slice(2))
    : resolve(settingsDirectory, source)
  return readLocalPackageName(packageDirectory)
}

async function readLocalPackageName(packageDirectory: string): Promise<string | null> {
  let manifest
  try {
    manifest = await open(join(packageDirectory, 'package.json'), 'r')
  } catch {
    return null
  }
  try {
    const stats = await manifest.stat()
    if (!stats.isFile()) return null
    const bytes = Buffer.alloc(MAX_PACKAGE_MANIFEST_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < bytes.byteLength) {
      const result = await manifest.read(
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        bytesRead
      )
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > MAX_PACKAGE_MANIFEST_BYTES) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    } catch {
      return null
    }
    if (!isRecord(parsed) || typeof parsed.name !== 'string') return null
    return isValidNpmPackageName(parsed.name) ? parsed.name : null
  } catch {
    return null
  } finally {
    await manifest.close().catch(() => undefined)
  }
}

function packageNameFromNpmSource(source: string): string | undefined {
  if (!source.startsWith('npm:')) return undefined
  const specifier = source.slice(4)
  const name = specifier.startsWith('@')
    ? /^(@[^/@]+\/[^/@]+)(?:@[^@]+)?$/u.exec(specifier)?.[1]
    : /^([^@]+)(?:@[^@]+)?$/u.exec(specifier)?.[1]
  if (name === undefined || !isValidNpmPackageName(name)) return undefined
  return name
}

function assertValidNpmPackageName(name: string): void {
  if (!isValidNpmPackageName(name)) throw new Error('Invalid npm package name.')
}

function isValidNpmPackageName(name: string): boolean {
  if (name.length === 0 || name.length > 214 || name !== name.toLowerCase()) return false
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(name)
}

function isLocalPackageSource(source: string): boolean {
  return source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~/') ||
    (!/^[a-z][a-z0-9+.-]*:/iu.test(source) && /[\\/]/u.test(source))
}

function isValidPackageFilterEntry(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\0\r\n]/u.test(value)
}

function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(attributes)
  return match === null ? undefined : decodeHtml(match[1] ?? match[2] ?? match[3] ?? '')
}

function findDataAttribute(html: string, name: string): string | undefined {
  const openingTag = new RegExp(`<[^>]+\\b${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)[^>]*>`, 'iu').exec(html)
  return openingTag === null ? undefined : readAttribute(openingTag[0], name)
}

function normalizeText(html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim()
}

function decodeHtml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos|nbsp);/giu, (entity, decimal, hex) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal))
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
    return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity.toLowerCase()] ?? entity
  })
}

async function runPiCommand(
  executable: string,
  args: readonly string[],
  options: PiDevCommandOptions
): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: options.shell,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let outputBytes = 0
    let outputExceeded = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolveCommand()
      else rejectCommand(error)
    }

    const countOutput = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > options.maxOutputBytes) {
        outputExceeded = true
        child.kill('SIGKILL')
      }
    }
    child.stdout?.on('data', countOutput)
    child.stderr?.on('data', countOutput)
    child.once('error', () => finish(new Error('Unable to start Pi package command.')))
    child.once('close', (code) => {
      if (timedOut) return finish(new Error('Pi package command timed out.'))
      if (outputExceeded) return finish(new Error('Pi package command output limit exceeded.'))
      if (code !== 0) return finish(new Error('Pi package command exited unsuccessfully.'))
      finish()
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
