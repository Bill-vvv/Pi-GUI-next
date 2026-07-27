export type ToolImageRequestIdentity = {
  requestId: number
  sessionKey: string | null
  toolCallId: string
  contentIndex: number
}

export function sameToolImageRequest(
  current: ToolImageRequestIdentity,
  expected: ToolImageRequestIdentity
): boolean {
  return current.requestId === expected.requestId &&
    current.sessionKey === expected.sessionKey &&
    current.toolCallId === expected.toolCallId &&
    current.contentIndex === expected.contentIndex
}
