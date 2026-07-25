import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import ignore, { type Ignore } from 'ignore'

import type { KernelProjectPathMatch } from '../../shared/kernel-contract.ts'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 100
const MAX_QUERY_LENGTH = 256
const IGNORE_FILES = ['.gitignore', '.ignore'] as const
const SKIPPABLE_SCAN_ERRORS = new Set(['EACCES', 'ELOOP', 'ENOENT', 'ENOTDIR', 'EPERM'])
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW

type SearchOptions = {
  projectPath: string
  query: string
  limit?: number
}

type ScoredMatch = KernelProjectPathMatch & {
  score: readonly [number, number, number]
}

export async function searchProjectPaths({
  projectPath,
  query,
  limit = DEFAULT_LIMIT
}: SearchOptions): Promise<KernelProjectPathMatch[]> {
  validateArguments(projectPath, query, limit)

  const expectedRoot = resolve(projectPath)
  const canonicalRoot = await realpath(projectPath)
  if (canonicalRoot !== expectedRoot) {
    throw new Error('Project path no longer resolves canonically.')
  }

  const rootStat = await lstat(canonicalRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Project path is not a directory.')
  }

  const matcher = ignore()
  const matches: ScoredMatch[] = []
  await scanDirectory(canonicalRoot, canonicalRoot, '', matcher, query, matches, true)

  matches.sort(compareMatches)
  return matches.slice(0, limit).map(({ path, kind }) => ({ path, kind }))
}

async function scanDirectory(
  canonicalRoot: string,
  directoryPath: string,
  relativeDirectory: string,
  matcher: Ignore,
  query: string,
  matches: ScoredMatch[],
  isRoot: boolean
): Promise<void> {
  const initialMatchCount = matches.length
  let directoryHandle
  try {
    directoryHandle = await open(directoryPath, DIRECTORY_OPEN_FLAGS)
  } catch (error) {
    if (!isRoot && isSkippableScanError(error)) return
    throw error
  }

  try {
    const directoryStat = await directoryHandle.stat()
    if (!directoryStat.isDirectory()) throw new Error('Project path is not a directory.')
    const pinnedDirectoryPath = `/proc/self/fd/${directoryHandle.fd}`
    const expectedDirectoryPath = resolve(canonicalRoot, relativeDirectory)
    const canonicalDirectoryPath = await realpath(pinnedDirectoryPath)
    if (
      canonicalDirectoryPath !== expectedDirectoryPath ||
      !isWithinRoot(canonicalRoot, canonicalDirectoryPath)
    ) {
      throw new Error('Project directory no longer resolves canonically within the root.')
    }

    for (const ignoreFile of IGNORE_FILES) {
      const rules = await readIgnoreRules(join(pinnedDirectoryPath, ignoreFile))
      if (rules !== null) matcher.add(rebaseIgnoreRules(rules, relativeDirectory))
    }

    const names = await readdir(pinnedDirectoryPath)
    names.sort(compareStringsByBytes)

    for (const name of names) {
      const entryPath = join(pinnedDirectoryPath, name)
      let entryStat
      try {
        entryStat = await lstat(entryPath)
      } catch (error) {
        if (isSkippableScanError(error)) continue
        throw error
      }

      if (entryStat.isSymbolicLink()) continue
      const isDirectory = entryStat.isDirectory()
      if (!isDirectory && !entryStat.isFile()) continue
      if (isDirectory && name === '.git') continue

      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`
      if (CONTROL_CHARACTER.test(relativePath)) continue
      const matchPath = isDirectory ? `${relativePath}/` : relativePath
      if (matcher.ignores(matchPath)) continue

      const score = fuzzyScore(relativePath, query)
      if (score !== null) {
        matches.push({
          path: relativePath,
          kind: isDirectory ? 'directory' : 'file',
          score
        })
      }

      if (isDirectory) {
        await scanDirectory(
          canonicalRoot,
          entryPath,
          relativePath,
          matcher,
          query,
          matches,
          false
        )
      }
    }
  } catch (error) {
    if (!isRoot && isSkippableScanError(error)) {
      matches.length = initialMatchCount
      return
    }
    throw error
  } finally {
    await directoryHandle.close()
  }
}

async function readIgnoreRules(filePath: string): Promise<string | null> {
  let fileStat
  try {
    fileStat = await lstat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null

  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ELOOP')) return null
    throw error
  }

  try {
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) return null
    let rules: string
    try {
      rules = UTF8_DECODER.decode(await handle.readFile())
    } catch {
      throw new Error('Invalid UTF-8 in project ignore file.')
    }
    if (CONTROL_CHARACTER.test(rules.replaceAll('\n', '').replaceAll('\r', '').replaceAll('\t', ''))) {
      throw new Error('Invalid control character in project ignore file.')
    }
    return rules
  } finally {
    await handle.close()
  }
}

function rebaseIgnoreRules(rules: string, relativeDirectory: string): string {
  if (relativeDirectory === '') return rules
  return rules
    .split(/\r?\n/u)
    .map((line) => rebaseIgnoreRule(line, relativeDirectory))
    .join('\n')
}

function rebaseIgnoreRule(line: string, relativeDirectory: string): string {
  if (line === '' || line.startsWith('#')) return line

  const negative = line.startsWith('!')
  const prefix = negative ? '!' : ''
  const pattern = negative ? line.slice(1) : line
  if (pattern === '') return line
  if (pattern.startsWith('/')) return `${prefix}${relativeDirectory}/${pattern.slice(1)}`

  const withoutDirectoryMarker = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
  if (withoutDirectoryMarker.includes('/')) {
    return `${prefix}${relativeDirectory}/${pattern}`
  }
  return `${prefix}${relativeDirectory}/**/${pattern}`
}

function fuzzyScore(path: string, query: string): readonly [number, number, number] | null {
  if (query === '') return [0, 0, 0]

  const candidateCharacters = Array.from(path.toLocaleLowerCase('en-US'))
  const queryCharacters = Array.from(query.toLocaleLowerCase('en-US'))
  let queryIndex = 0
  let firstMatch = -1
  let previousMatch = -1
  let gaps = 0

  for (let candidateIndex = 0; candidateIndex < candidateCharacters.length; candidateIndex += 1) {
    if (candidateCharacters[candidateIndex] !== queryCharacters[queryIndex]) continue
    if (firstMatch === -1) firstMatch = candidateIndex
    if (previousMatch !== -1) gaps += candidateIndex - previousMatch - 1
    previousMatch = candidateIndex
    queryIndex += 1
    if (queryIndex === queryCharacters.length) {
      return [gaps, firstMatch, candidateCharacters.length]
    }
  }
  return null
}

function compareMatches(left: ScoredMatch, right: ScoredMatch): number {
  for (let index = 0; index < left.score.length; index += 1) {
    const difference = left.score[index] - right.score[index]
    if (difference !== 0) return difference
  }
  return compareStringsByBytes(left.path, right.path)
}

function compareStringsByBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function isWithinRoot(canonicalRoot: string, candidate: string): boolean {
  const relativePath = relative(canonicalRoot, candidate)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

function validateArguments(projectPath: string, query: string, limit: number): void {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) {
    throw new Error('Project path must be absolute.')
  }
  if (typeof query !== 'string') throw new Error('Project path query must be a string.')
  if (Array.from(query).length > MAX_QUERY_LENGTH) {
    throw new Error(`Project path query must not exceed ${MAX_QUERY_LENGTH} characters.`)
  }
  if (CONTROL_CHARACTER.test(query)) {
    throw new Error('Project path query must not contain control characters.')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Project path search limit must be an integer from 1 to ${MAX_LIMIT}.`)
  }
}

function isSkippableScanError(error: unknown): boolean {
  return isNodeError(error) && SKIPPABLE_SCAN_ERRORS.has(error.code)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}
