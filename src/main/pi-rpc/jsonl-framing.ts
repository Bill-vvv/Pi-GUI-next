import { StringDecoder } from 'node:string_decoder'

import { errorMessage } from '../utils/errors.ts'

const MAX_UNTERMINATED_PREVIEW_CHARS = 120

export type JsonlParseBatch = {
  records: unknown[]
  /** UTF-8 bytes for each parsed raw record, including its LF or CRLF terminator. */
  recordByteLengths: number[]
  errors: Error[]
}

/** Strict LF-delimited JSONL framing for Pi RPC stdout. */
export class LfJsonlParser {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private ended = false

  push(chunk: string | Uint8Array): JsonlParseBatch {
    if (this.ended) {
      throw new Error('Cannot push to an ended Pi RPC JSONL parser')
    }

    return this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk)))
  }

  end(tail?: string | Uint8Array): JsonlParseBatch {
    if (this.ended) {
      throw new Error('Pi RPC JSONL parser has already ended')
    }
    this.ended = true

    let decodedTail = ''
    if (tail !== undefined) {
      decodedTail += typeof tail === 'string' ? tail : this.decoder.write(Buffer.from(tail))
    }
    decodedTail += this.decoder.end()

    const batch = this.consume(decodedTail)
    if (this.buffer.length > 0) {
      batch.errors.push(new Error(formatUnterminatedJsonlError(this.buffer)))
      this.buffer = ''
    }
    return batch
  }

  private consume(text: string): JsonlParseBatch {
    const batch: JsonlParseBatch = { records: [], recordByteLengths: [], errors: [] }
    this.buffer += text

    for (;;) {
      const newlineIndex = this.buffer.indexOf('\n')
      if (newlineIndex === -1) {
        break
      }

      const rawLine = this.buffer.slice(0, newlineIndex)
      const recordByteLength = Buffer.byteLength(`${rawLine}\n`, 'utf8')
      let line = rawLine
      this.buffer = this.buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (line.length === 0) {
        continue
      }

      try {
        batch.records.push(JSON.parse(line))
        batch.recordByteLengths.push(recordByteLength)
      } catch (error) {
        const detail = errorMessage(error)
        batch.errors.push(new Error(`Failed to parse Pi RPC JSONL record: ${detail}`))
      }
    }

    return batch
  }
}

export function formatUnterminatedJsonlError(buffer: string): string {
  const preview =
    buffer.length > MAX_UNTERMINATED_PREVIEW_CHARS
      ? `${buffer.slice(0, MAX_UNTERMINATED_PREVIEW_CHARS)}…`
      : buffer
  return `Pi RPC stdout ended with an unterminated JSONL record (${buffer.length} chars): ${JSON.stringify(preview)}`
}
