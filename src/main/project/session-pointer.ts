export type SessionPointer = {
  projectPath: string
  sessionFile: string
  sessionId: string
  sessionName: string | null
}

export type ProjectSessionRegistry = {
  sessions: SessionPointer[]
  activeSessionKey: string | null
  manualOrder?: boolean
}

export function upsertSessionPointer(
  pointers: SessionPointer[],
  pointer: SessionPointer
): SessionPointer[] {
  const index = pointers.findIndex((existing) =>
    existing.sessionFile === pointer.sessionFile ||
    (
      existing.projectPath === pointer.projectPath &&
      existing.sessionId === pointer.sessionId
    )
  )
  if (index === -1) return [...pointers, { ...pointer }]
  return pointers.map((existing, pointerIndex) =>
    pointerIndex === index ? { ...pointer } : { ...existing }
  )
}
