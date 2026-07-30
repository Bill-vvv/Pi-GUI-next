export type RestartContinuationCandidate = {
  id: string
  projectPath: string
  sessionFile: string
  sessionId: string
  capturedAt: number
}

export type RestartContinuationStatus = 'pending' | 'claimed'

export type RestartContinuationRecord = RestartContinuationCandidate & {
  status: RestartContinuationStatus
}
