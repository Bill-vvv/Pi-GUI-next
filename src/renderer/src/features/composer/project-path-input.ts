import { formatPathReference } from '../../../../shared/path-reference.ts'

export type ActiveProjectPathToken = {
  query: string
  start: number
  end: number
}

export type ProjectPathReplacement = {
  value: string
  cursor: number
}

export function parseActiveProjectPathToken(
  input: string,
  cursor: number
): ActiveProjectPathToken | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > input.length) return null
  if (cursor === 0) return null

  let start = input.lastIndexOf('@', cursor - 1)
  while (start !== -1) {
    if (start === 0 || /\s/u.test(input[start - 1])) {
      const quoted = input[start + 1] === '"'
      const queryStart = start + (quoted ? 2 : 1)
      if (queryStart <= cursor) {
        const rawQuery = input.slice(queryStart, cursor)
        if (quoted) {
          const query = decodeOpenQuotedQuery(rawQuery)
          if (query !== null) {
            return {
              query,
              start,
              end: findQuotedTokenEnd(input, queryStart)
            }
          }
        } else if (!/\s/u.test(rawQuery)) {
          return {
            query: rawQuery,
            start,
            end: findUnquotedTokenEnd(input, cursor)
          }
        }
      }
    }
    if (start === 0) break
    start = input.lastIndexOf('@', start - 1)
  }

  return null
}

export function replaceProjectPathToken(
  input: string,
  token: ActiveProjectPathToken,
  path: string
): ProjectPathReplacement {
  if (
    !Number.isInteger(token.start) ||
    !Number.isInteger(token.end) ||
    token.start < 0 ||
    token.end < token.start ||
    token.end > input.length
  ) {
    throw new Error('Project path token range is invalid.')
  }

  const reference = formatPathReference(path)
  return {
    value: input.slice(0, token.start) + reference + input.slice(token.end),
    cursor: token.start + reference.length
  }
}

function decodeOpenQuotedQuery(rawQuery: string): string | null {
  let query = ''
  for (let index = 0; index < rawQuery.length; index += 1) {
    const character = rawQuery[index]
    if (character === '"') return null
    if (character === '\\' && index + 1 < rawQuery.length) {
      index += 1
      query += rawQuery[index]
    } else {
      query += character
    }
  }
  return query
}

function findUnquotedTokenEnd(input: string, cursor: number): number {
  let end = cursor
  while (end < input.length && !/\s/u.test(input[end])) end += 1
  return end
}

function findQuotedTokenEnd(input: string, cursor: number): number {
  let escaped = false
  for (let end = cursor; end < input.length; end += 1) {
    const character = input[end]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '"') return end + 1
  }
  return input.length
}
