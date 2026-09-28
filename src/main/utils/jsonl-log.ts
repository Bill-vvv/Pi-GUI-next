import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>

export type JsonlLogger = {
  write(level: LogLevel, component: string, event: string, fields?: LogFields): void
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_ROTATED_FILES = 2
const MAX_FIELD_CHARS = 500

/**
 * Minimal per-process JSON Lines log (D-099). Callers pass lifecycle metadata only:
 * never prompts, conversation text, file contents, machine secrets or credentials.
 * Writing is synchronous so the last record before a crash is kept, and it never throws.
 */
export function createJsonlLogger(options: {
  directory: string
  name: string
  maxBytes?: number
  maxRotatedFiles?: number
  now?: () => Date
}): JsonlLogger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRotatedFiles = options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES
  const now = options.now ?? (() => new Date())
  const path = join(options.directory, `${options.name}.jsonl`)
  const rotated = (index: number): string => join(options.directory, `${options.name}.${index}.jsonl`)
  let size: number | null = null
  let reportedFailure = false

  const rotate = (): void => {
    rmSync(rotated(maxRotatedFiles), { force: true })
    for (let index = maxRotatedFiles - 1; index >= 1; index--) {
      try { renameSync(rotated(index), rotated(index + 1)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (maxRotatedFiles > 0) renameSync(path, rotated(1))
    else rmSync(path, { force: true })
    size = 0
  }

  return {
    write(level, component, event, fields = {}) {
      try {
        const record: Record<string, unknown> = { time: now().toISOString(), level, component, event }
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined || Object.hasOwn(record, key)) continue
          record[key] = typeof value === 'string' && value.length > MAX_FIELD_CHARS
            ? `${value.slice(0, MAX_FIELD_CHARS)}…`
            : value
        }
        const line = `${JSON.stringify(record)}\n`
        const bytes = Buffer.byteLength(line)
        if (size === null) {
          mkdirSync(options.directory, { recursive: true, mode: 0o700 })
          try { size = statSync(path).size } catch { size = 0 }
        }
        if (size > 0 && size + bytes > maxBytes) rotate()
        appendFileSync(path, line, { mode: 0o600 })
        size += bytes
      } catch (error) {
        if (reportedFailure) return
        reportedFailure = true
        console.error(`[Pi GUI] Log file unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export const NOOP_LOGGER: JsonlLogger = { write() {} }
