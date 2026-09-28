/** Renderer selection intent; canonical Session identity remains in Kernel state. */
export type SessionViewTarget =
  | {
      kind: 'session'
      projectKey: string
      sessionKey: string
    }
  | {
      kind: 'new'
      projectKey: string
      prepared: boolean
      sawProvisional: boolean
    }

