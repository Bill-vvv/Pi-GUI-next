export type SessionActivitySnapshot = {
  sessionKey: string
  lastActivityAt: number | null
  runtimeStatus: 'starting' | 'ready' | 'running' | 'stopping' | 'stopped' | 'crashed'
}

export type SessionActivityObservation = SessionActivitySnapshot & {
  identity: string
}

export function indexSessionActivity(
  observations: readonly SessionActivityObservation[]
): Map<string, SessionActivitySnapshot> {
  return new Map(observations.map(({ identity, sessionKey, lastActivityAt, runtimeStatus }) => [
    identity,
    { sessionKey, lastActivityAt, runtimeStatus }
  ]))
}

export function reconcileUnreadSessionKeys(
  current: Set<string>,
  displayedSessionKey: string | null,
  previousByIdentity: ReadonlyMap<string, SessionActivitySnapshot>,
  observations: readonly SessionActivityObservation[]
): Set<string> {
  let next = current
  const observedIdentities = new Set<string>()

  const mutableNext = (): Set<string> => {
    if (next === current) next = new Set(next)
    return next
  }

  for (const observation of observations) {
    observedIdentities.add(observation.identity)
    const previous = previousByIdentity.get(observation.identity)
    let inheritedUnread = false

    if (
      previous !== undefined &&
      previous.sessionKey !== observation.sessionKey &&
      next.has(previous.sessionKey)
    ) {
      mutableNext().delete(previous.sessionKey)
      inheritedUnread = true
    }

    if (observation.sessionKey === displayedSessionKey) {
      if (next.has(observation.sessionKey)) mutableNext().delete(observation.sessionKey)
      continue
    }

    const receivedNewMessage = previous !== undefined &&
      previous.lastActivityAt !== null &&
      observation.lastActivityAt !== null &&
      observation.lastActivityAt > previous.lastActivityAt
    const completedBackgroundRun = previous?.runtimeStatus === 'running' &&
      (observation.runtimeStatus === 'ready' || observation.runtimeStatus === 'crashed')
    if (
      (inheritedUnread || receivedNewMessage || completedBackgroundRun) &&
      !next.has(observation.sessionKey)
    ) {
      mutableNext().add(observation.sessionKey)
    }
  }

  for (const [identity, previous] of previousByIdentity) {
    if (observedIdentities.has(identity) || !next.has(previous.sessionKey)) continue
    mutableNext().delete(previous.sessionKey)
  }

  return next
}
