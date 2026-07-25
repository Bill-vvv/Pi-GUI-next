import { isAbsolute, resolve } from 'node:path'

import { resolvePiAgentDir } from '../extension/pi-extension-store.ts'
import {
  importVerifiedPiPackageRoot,
  type PiPackageRootOptions
} from '../runtime/pi-package-root.ts'

type PiTrustRootExports = {
  hasTrustRequiringProjectResources: (cwd: string) => boolean
  ProjectTrustStore: new (agentDir: string) => {
    getEntry: (cwd: string) => { path: string, decision: boolean } | null
    set: (cwd: string, decision: boolean) => void
  }
}

export type PiProjectTrustInspection = {
  requiresDecision: boolean
  decision: boolean | null
}

export type PiProjectTrustOptions = PiPackageRootOptions & {
  agentDir?: string
}

export class PiProjectTrust {
  private readonly options: PiProjectTrustOptions
  private exportsPromise: Promise<PiTrustRootExports> | null = null

  constructor(options: PiProjectTrustOptions = {}) {
    this.options = options
  }

  async inspect(projectPath: string): Promise<PiProjectTrustInspection> {
    assertCanonicalProjectPath(projectPath)
    const exports = await this.loadExports(projectPath)
    if (!exports.hasTrustRequiringProjectResources(projectPath)) {
      return { requiresDecision: false, decision: null }
    }
    return {
      requiresDecision: true,
      decision: new exports.ProjectTrustStore(this.options.agentDir ?? resolvePiAgentDir())
        .getEntry(projectPath)?.decision ?? null
    }
  }

  async persist(projectPath: string, decision: boolean): Promise<void> {
    assertCanonicalProjectPath(projectPath)
    const exports = await this.loadExports(projectPath)
    new exports.ProjectTrustStore(this.options.agentDir ?? resolvePiAgentDir())
      .set(projectPath, decision)
  }

  private loadExports(cwd: string): Promise<PiTrustRootExports> {
    this.exportsPromise ??= loadPiTrustRootExports(cwd, this.options)
    return this.exportsPromise
  }
}

async function loadPiTrustRootExports(
  cwd: string,
  options: PiProjectTrustOptions
): Promise<PiTrustRootExports> {
  const imported = await importVerifiedPiPackageRoot(cwd, options)
  if (
    typeof imported.hasTrustRequiringProjectResources !== 'function' ||
    typeof imported.ProjectTrustStore !== 'function'
  ) {
    throw new Error('Pi package root export does not provide project trust capabilities.')
  }
  return imported as PiTrustRootExports
}

function assertCanonicalProjectPath(projectPath: string): void {
  if (!isAbsolute(projectPath) || resolve(projectPath) !== projectPath) {
    throw new Error(`Project path must be canonical and absolute: ${projectPath}`)
  }
}
