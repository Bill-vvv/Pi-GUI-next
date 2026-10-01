import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { KernelSessionStatistics } from '../../shared/kernel-contract.ts'
import type { SessionPointer } from './session-pointer.ts'
import { sessionStatistics, type SessionMetadata } from './session-statistics.ts'
import { readSessionTranscript, sessionActivityAt } from './session-transcript.ts'

/*
 * Persistent cache of the per-Session activity time and statistics shown in navigation.
 * Each entry is valid only for the exact file it was computed from (device, inode, size,
 * modification time) and the pointer's Session id, so an unchanged Session is never re-read
 * at startup and any append or rewrite is read again. Results and errors are identical to
 * the uncached readers; files that cannot be stat'ed are read uncached. Deleting the cache
 * file only costs one full read on the next startup.
 */

const CACHE_VERSION = 1
const SAVE_DELAY_MS = 2_000

type FileStamp = { dev: number, ino: number, size: number, mtimeMs: number }

type CacheEntry = FileStamp & {
  sessionId: string
  activityAt: number | null
  /** Exactly one of statistics / statisticsError is set. */
  statistics: KernelSessionStatistics | null
  statisticsError: string | null
}

export type SessionMetadataReaders = {
  readSessionActivityAt(pointer: SessionPointer): Promise<number | null>
  readSessionStatistics(pointer: SessionPointer): Promise<KernelSessionStatistics>
  readSessionMetadata(pointer: SessionPointer): Promise<SessionMetadata>
}

export class SessionMetadataCache implements SessionMetadataReaders {
  private readonly path: string
  private readonly entries: Map<string, CacheEntry>
  private readonly used = new Set<string>()
  private readonly pending = new Map<string, Promise<CacheEntry | null>>()
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  private reportedSaveFailure = false

  private constructor(path: string, entries: Map<string, CacheEntry>) {
    this.path = path
    this.entries = entries
  }

  /** Open the cache file; a missing, unreadable or foreign file starts an empty cache. */
  static async open(path: string): Promise<SessionMetadataCache> {
    let entries = new Map<string, CacheEntry>()
    try {
      entries = parseCache(await readFile(path, 'utf8'))
    } catch {
      // A cache is rebuilt from the Session files.
    }
    return new SessionMetadataCache(path, entries)
  }

  async readSessionActivityAt(pointer: SessionPointer): Promise<number | null> {
    const entry = await this.entry(pointer)
    if (entry === null) return uncachedActivityAt(pointer)
    return entry.activityAt
  }

  async readSessionStatistics(pointer: SessionPointer): Promise<KernelSessionStatistics> {
    const entry = await this.entry(pointer)
    if (entry === null) return sessionStatistics(await readSessionTranscript(pointer))
    return statisticsOrThrow(entry)
  }

  async readSessionMetadata(pointer: SessionPointer): Promise<SessionMetadata> {
    const entry = await this.entry(pointer)
    if (entry === null) {
      const entries = await readSessionTranscript(pointer)
      return { activityAt: sessionActivityAt(entries), statistics: sessionStatistics(entries) }
    }
    return { activityAt: entry.activityAt, statistics: statisticsOrThrow(entry) }
  }

  /** Write pending changes now (used at shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  /** The current entry for this pointer's file, computing it once; null when the file cannot be stat'ed. */
  private async entry(pointer: SessionPointer): Promise<CacheEntry | null> {
    const key = pointer.sessionFile
    this.used.add(key)
    const inFlight = this.pending.get(key)
    if (inFlight !== undefined) {
      const entry = await inFlight
      if (entry !== null && entry.sessionId === pointer.sessionId) return entry
    }
    const promise = this.resolve(pointer)
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    }
  }

  private async resolve(pointer: SessionPointer): Promise<CacheEntry | null> {
    const before = await stampOf(pointer.sessionFile)
    if (before === null) return null
    const cached = this.entries.get(pointer.sessionFile)
    if (cached !== undefined && cached.sessionId === pointer.sessionId && sameStamp(cached, before)) return cached

    let activityAt: number | null = null
    let statistics: KernelSessionStatistics | null = null
    let statisticsError: string | null = null
    try {
      const transcript = await readSessionTranscript(pointer)
      activityAt = sessionActivityAt(transcript)
      try {
        statistics = sessionStatistics(transcript)
      } catch (error) {
        statisticsError = errorText(error)
      }
    } catch (error) {
      statisticsError = errorText(error)
    }
    const entry: CacheEntry = { ...before, sessionId: pointer.sessionId, activityAt, statistics, statisticsError }
    // Only a result read from a file that stayed unchanged during the read is stored.
    const after = await stampOf(pointer.sessionFile)
    if (after !== null && sameStamp(before, after)) {
      this.entries.set(pointer.sessionFile, entry)
      this.markDirty()
    }
    return entry
  }

  private markDirty(): void {
    this.dirty = true
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      // Keep entries for Sessions read by this process; removed Sessions drop out.
      const entries: Record<string, CacheEntry> = {}
      for (const [key, entry] of this.entries) {
        if (this.used.has(key)) entries[key] = entry
      }
      const text = `${JSON.stringify({ version: CACHE_VERSION, entries })}\n`
      const temporary = `${this.path}.${process.pid}.tmp`
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(temporary, text, { mode: 0o600 })
        await rename(temporary, this.path)
      } catch (error) {
        this.dirty = true
        if (!this.reportedSaveFailure) {
          this.reportedSaveFailure = true
          console.error(`[Pi GUI] Session metadata cache could not be saved: ${errorText(error)}`)
        }
      }
    })
    return this.saving
  }
}

async function uncachedActivityAt(pointer: SessionPointer): Promise<number | null> {
  try {
    return sessionActivityAt(await readSessionTranscript(pointer))
  } catch {
    return null
  }
}

function statisticsOrThrow(entry: CacheEntry): KernelSessionStatistics {
  if (entry.statistics === null) throw new Error(entry.statisticsError ?? 'Invalid Pi session transcript.')
  return { ...entry.statistics }
}

async function stampOf(path: string): Promise<FileStamp | null> {
  try {
    const stats = await stat(path)
    if (!stats.isFile()) return null
    return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}

function sameStamp(left: FileStamp, right: FileStamp): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const STATISTIC_KEYS = [
  'userMessages', 'assistantMessages', 'toolCalls', 'toolResults', 'totalMessages', 'inputTokens',
  'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost'
] as const

function parseCache(text: string): Map<string, CacheEntry> {
  const value = JSON.parse(text) as unknown
  const entries = new Map<string, CacheEntry>()
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.entries)) return entries
  for (const [key, entry] of Object.entries(value.entries)) {
    if (isCacheEntry(entry)) entries.set(key, entry)
  }
  return entries
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value)) return false
  const numbers = ['dev', 'ino', 'size', 'mtimeMs'] as const
  if (!numbers.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) return false
  if (typeof value.sessionId !== 'string') return false
  if (value.activityAt !== null && (typeof value.activityAt !== 'number' || !Number.isFinite(value.activityAt))) return false
  if (value.statistics === null) return typeof value.statisticsError === 'string'
  return value.statisticsError === null && isRecord(value.statistics) &&
    STATISTIC_KEYS.every((key) => typeof (value.statistics as Record<string, unknown>)[key] === 'number')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
