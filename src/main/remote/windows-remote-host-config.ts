export type WindowsRemoteHostConfig = {
  sshHostAlias: string
  localPort: number
  desktopHostPort: number
}

const SSH_HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export function parseWindowsRemoteHostConfig(value: unknown): WindowsRemoteHostConfig {
  if (!isRecord(value) || Object.keys(value).length !== 3) {
    throw new Error('Windows remote host config must contain exactly sshHostAlias, localPort, and desktopHostPort.')
  }
  if (
    typeof value.sshHostAlias !== 'string' ||
    !SSH_HOST_ALIAS_PATTERN.test(value.sshHostAlias)
  ) {
    throw new Error('SSH host alias must be 1 to 128 ASCII letters, digits, dots, underscores, or hyphens and must not begin with an option prefix.')
  }
  return {
    sshHostAlias: value.sshHostAlias,
    localPort: parsePort(value.localPort, 'localPort'),
    desktopHostPort: parsePort(value.desktopHostPort, 'desktopHostPort')
  }
}

function parsePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
