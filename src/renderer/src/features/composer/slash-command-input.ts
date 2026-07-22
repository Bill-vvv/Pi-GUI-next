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

export function parseSlashCommandToken(input: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(input)
  return match?.[1] ?? null
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

  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(message)
  const name = match?.[1] ?? message.slice(1).split(/\s/, 1)[0] ?? ''
  const command = commands.find(
    (candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  )
  if (!match || !command) return { kind: 'unknown', name }

  return {
    kind: 'command',
    command,
    argument: (match[2] ?? '').trim()
  }
}
