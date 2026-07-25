export type SlashCommandLike = {
  id: string
  name: string
  description: string
  source: string
  argumentHint: string | null
}

export type ResolvedSlashCommand<T extends SlashCommandLike> =
  | { kind: 'prompt' }
  | { kind: 'unknown'; name: string }
  | { kind: 'command'; command: T; argument: string }

export function parseSlashCommandToken<T extends SlashCommandLike>(
  input: string,
  commands: readonly T[]
): string | null {
  const match = /^\/([^\s]*)$/.exec(input)
  const query = match?.[1] ?? null
  if (query === null) return null
  if (
    query.includes('/') &&
    !commands.some((command) =>
      command.name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())
    )
  ) {
    return null
  }
  return query
}

export function filterSlashCommands<T extends SlashCommandLike>(
  commands: readonly T[],
  query: string
): T[] {
  const normalizedQuery = query.toLocaleLowerCase()
  return commands.filter((command) =>
    [command.name, command.description, command.source].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
}

export function resolveSlashCommand<T extends SlashCommandLike>(
  input: string,
  commands: readonly T[]
): ResolvedSlashCommand<T> {
  const message = input.trim()
  if (!message.startsWith('/')) return { kind: 'prompt' }

  const separatorIndex = message.search(/\s/)
  const nameEnd = separatorIndex === -1 ? message.length : separatorIndex
  const name = message.slice(1, nameEnd)
  const command = commands.find(
    (candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  )
  if (command === undefined) {
    return name.includes('/') ? { kind: 'prompt' } : { kind: 'unknown', name }
  }

  return {
    kind: 'command',
    command,
    argument: message.slice(nameEnd).trim()
  }
}
