import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const BUILD_IDENTITY_FILE_NAME = 'build-identity.json'
const HASH = /^[a-f0-9]{64}$/u
const SOURCE_PATHS = ['src', 'extensions', 'scripts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'vite.remote.config.ts']
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|css|html|md|sh|ps1)$/u

export type BuildIdentity = {
  schemaVersion: 1
  commit: string
  sourceDigest: string
  artifactDigest: string
  files: Record<string, string>
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function listFiles(root: string, relative: string): string[] {
  const path = join(root, relative)
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error(`Build input cannot be a symlink: ${relative}`)
  if (info.isFile()) return [relative]
  if (!info.isDirectory()) throw new Error(`Unsupported build input: ${relative}`)
  return readdirSync(path).sort().filter((name) => !['node_modules', '.git', '.DS_Store'].includes(name))
    .flatMap((name) => listFiles(root, `${relative}/${name}`))
}

/** Hash actual source, including uncommitted edits; normalize text checkout line endings. */
export function sourceBuildDigest(root: string): string {
  const entries = SOURCE_PATHS.flatMap((path) => listFiles(root, path)).sort().map((path) => {
    const bytes = readFileSync(join(root, path))
    return [path, hash(TEXT_FILE.test(path) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes)]
  })
  return hash(JSON.stringify(entries))
}

function artifactPaths(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const resources: string[] = pkg.build.extraResources.map((entry: { from: string }) => entry.from)
  return [...new Set([
    'package.json', 'pnpm-lock.yaml',
    ...listFiles(root, 'out').filter((path) => path !== `out/main/${BUILD_IDENTITY_FILE_NAME}`),
    ...resources.flatMap((path) => listFiles(root, path))
  ])].sort()
}

export function createBuildIdentity(root: string, commit: string, expectedSourceDigest = sourceBuildDigest(root)): BuildIdentity {
  if (sourceBuildDigest(root) !== expectedSourceDigest) throw new Error('Source changed during the build. Build again before starting or syncing.')
  const files = Object.fromEntries(artifactPaths(root).map((path) => [path, hash(readFileSync(join(root, path)))]))
  return parseBuildIdentity({ schemaVersion: 1, commit, sourceDigest: expectedSourceDigest, artifactDigest: hash(JSON.stringify(files)), files })
}

export function parseBuildIdentity(value: unknown): BuildIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid build manifest. Rebuild Pi GUI.')
  const identity = value as BuildIdentity
  if (Object.keys(identity).length !== 5 || identity.schemaVersion !== 1 ||
      typeof identity.commit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(identity.commit) ||
      typeof identity.sourceDigest !== 'string' || !HASH.test(identity.sourceDigest) ||
      typeof identity.artifactDigest !== 'string' || !HASH.test(identity.artifactDigest) ||
      identity.files === null || typeof identity.files !== 'object' || Array.isArray(identity.files)) throw new Error('Invalid build manifest. Rebuild Pi GUI.')
  const entries = Object.entries(identity.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (entries.length === 0 || entries.some(([path, digest]) =>
    !/^(?:out\/|extensions\/|package\.json$|pnpm-lock\.yaml$)/u.test(path) ||
    /[\\\0\r\n]/u.test(path) || path.split('/').some((part) => part === '..' || part === '.' || part === '') || typeof digest !== 'string' || !HASH.test(digest)
  )) throw new Error('Invalid build manifest file entry.')
  for (const path of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    if (!Object.hasOwn(identity.files, path)) throw new Error(`Build manifest is missing ${path}.`)
  }
  const files = Object.fromEntries(entries)
  if (hash(JSON.stringify(files)) !== identity.artifactDigest) throw new Error('Build manifest digest mismatch.')
  return { ...identity, files }
}

export function readBuildIdentityFile(filePath: string): BuildIdentity | null {
  if (!existsSync(filePath)) return null
  return parseBuildIdentity(JSON.parse(readFileSync(filePath, 'utf8')))
}

export function verifyBuildArtifacts(root: string, identity: BuildIdentity, resourcesRoot?: string): void {
  for (const [path, digest] of Object.entries(identity.files)) {
    // electron-builder owns installed dependencies and rewrites package.json while packaging.
    if (resourcesRoot !== undefined && (path === 'pnpm-lock.yaml' || path === 'package.json')) continue
    const file = resourcesRoot !== undefined && path.startsWith('extensions/') ? join(resourcesRoot, path) : join(root, path)
    if (hash(readFileSync(file)) !== digest) throw new Error(`Build artifact changed: ${path}. Rebuild and sync Pi GUI.`)
  }
}

export function resolveBuildCommit(options: {
  identityFilePath: string
  developmentRoot?: string
  resourcesRoot?: string
}): string | null {
  if (options.developmentRoot !== undefined) return sourceBuildDigest(options.developmentRoot)
  const identity = readBuildIdentityFile(options.identityFilePath)
  if (identity === null) return null
  verifyBuildArtifacts(resolve(options.identityFilePath, '../../..'), identity, options.resourcesRoot)
  return identity.sourceDigest
}
