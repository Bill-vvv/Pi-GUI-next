import type { KernelState, RuntimeStatus } from '../../../../shared/kernel-contract'

export type SessionLifecycleObservation = {
  identity: string
  projectKey: string
  workspaceKind: 'project' | 'task'
  taskKey: string | null
  sessionKey: string
  sessionId: string
  sessionName: string | null
  runtimeStatus: RuntimeStatus
}

export type BackgroundSessionNotification = SessionLifecycleObservation & {
  outcome: 'completed' | 'crashed'
}

export function collectSessionLifecycleObservations(
  state: Pick<KernelState, 'projects' | 'activeProjectKey' | 'sessions'>
): SessionLifecycleObservation[] {
  const observations = new Map<string, SessionLifecycleObservation>()

  const addSessions = (
    project: KernelState['projects'][number],
    sessions: KernelState['sessions']
  ): void => {
    for (const session of sessions) {
      const identity = `${project.path}\u0000${session.id}`
      observations.set(identity, {
        identity,
        projectKey: project.path,
        workspaceKind: project.workspaceKind === 'task' ? 'task' : 'project',
        taskKey: project.taskKey ?? null,
        sessionKey: session.key,
        sessionId: session.id,
        sessionName: session.name,
        runtimeStatus: session.runtimeStatus
      })
    }
  }

  for (const project of state.projects) addSessions(project, project.sessions ?? [])
  const activeProject = state.projects.find(({ path }) => path === state.activeProjectKey)
  if (activeProject !== undefined) addSessions(activeProject, state.sessions)

  return [...observations.values()]
}

export function indexSessionLifecycles(
  observations: readonly SessionLifecycleObservation[]
): Map<string, SessionLifecycleObservation> {
  return new Map(observations.map((observation) => [observation.identity, observation]))
}

export function reconcileBackgroundSessionNotifications(
  current: readonly BackgroundSessionNotification[],
  displayedSessionKey: string | null,
  previousByIdentity: ReadonlyMap<string, SessionLifecycleObservation>,
  observations: readonly SessionLifecycleObservation[]
): readonly BackgroundSessionNotification[] {
  const observedByIdentity = indexSessionLifecycles(observations)
  let next = current.flatMap((notification) => {
    const observation = observedByIdentity.get(notification.identity)
    if (observation === undefined || observation.sessionKey === displayedSessionKey) return []
    return [{ ...notification, ...observation }]
  })

  for (const observation of observations) {
    if (observation.sessionKey === displayedSessionKey) continue
    const previous = previousByIdentity.get(observation.identity)
    if (previous?.runtimeStatus !== 'running') continue
    const outcome = observation.runtimeStatus === 'ready'
      ? 'completed'
      : observation.runtimeStatus === 'crashed' ? 'crashed' : null
    if (outcome === null) continue

    next = [
      ...next.filter(({ identity }) => identity !== observation.identity),
      { ...observation, outcome }
    ]
  }

  const bounded = next.slice(-3)
  return sameNotifications(current, bounded) ? current : bounded
}

function sameNotifications(
  current: readonly BackgroundSessionNotification[],
  next: readonly BackgroundSessionNotification[]
): boolean {
  return current.length === next.length && current.every((notification, index) => {
    const other = next[index]
    return other !== undefined &&
      notification.identity === other.identity &&
      notification.projectKey === other.projectKey &&
      notification.workspaceKind === other.workspaceKind &&
      notification.taskKey === other.taskKey &&
      notification.sessionKey === other.sessionKey &&
      notification.sessionId === other.sessionId &&
      notification.sessionName === other.sessionName &&
      notification.runtimeStatus === other.runtimeStatus &&
      notification.outcome === other.outcome
  })
}
