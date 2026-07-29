export type GitProjectResolverKernel = {
  getState(): {
    navigatorKind?: 'project' | 'task'
    activeProjectKey: string | null
    projects: Array<{
      path: string
      workspaceKind?: 'project' | 'task'
    }>
  }
}

export type GitProjectResolverStore = {
  loadProjects(): Promise<{
    projects: Array<{ path: string }>
    activeProjectKey: string | null
  }>
  validateProjectPath(path: string): Promise<string>
}

export function createActiveRegisteredGitProjectResolver(
  kernel: GitProjectResolverKernel,
  projectStore: GitProjectResolverStore
): (projectKey: string) => Promise<string> {
  return async (projectKey) => {
    assertActiveUserProject(kernel.getState(), projectKey)

    const registry = await projectStore.loadProjects()
    if (!registry.projects.some(({ path }) => path === projectKey)) {
      throw new Error('Active Git Project is not registered.')
    }

    const canonicalPath = await projectStore.validateProjectPath(projectKey)
    if (canonicalPath !== projectKey) {
      throw new Error('Active Git Project path no longer resolves canonically.')
    }

    // Loading the registry and resolving the filesystem path are asynchronous. Recheck the
    // navigator immediately before returning cwd authority to the Git controller.
    assertActiveUserProject(kernel.getState(), projectKey)
    return canonicalPath
  }
}

function assertActiveUserProject(
  state: ReturnType<GitProjectResolverKernel['getState']>,
  projectKey: string
): void {
  if (state.navigatorKind !== 'project' || state.activeProjectKey !== projectKey) {
    throw new Error('Git is only available for the active Project navigator entry.')
  }
  const project = state.projects.find(({ path }) => path === projectKey)
  if (project === undefined || project.workspaceKind === 'task') {
    throw new Error('Git is unavailable for Tasks or unregistered workspaces.')
  }
}
