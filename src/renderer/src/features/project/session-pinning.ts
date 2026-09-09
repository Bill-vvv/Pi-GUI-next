export function sessionPinIdentity(
  workspaceKind: 'project' | 'task',
  ownerKey: string,
  sessionId: string
): string {
  return `${workspaceKind}:${ownerKey}\u0000${sessionId}`
}
