import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import {
  KERNEL_CONVERSATION_PAGE_TURN_COUNT,
  conversationTurnWindowStartIndex
} from '../../shared/conversation-window.ts'
import type {
  KernelConversationPage,
  KernelSessionPreview,
  KernelSessionPreviewPageRequest
} from '../../shared/kernel-contract.ts'
import type { ProjectSessionRegistry, SessionPointer } from '../project/session-pointer.ts'
import type { SessionTranscriptPreparationCache } from '../project/session-transcript-preparation-cache.ts'
import type { SessionTranscriptMessagePhase } from '../project/session-transcript-tail.ts'
import { projectTranscriptMessages } from './conversation-projection.ts'
import {
  assertConversationPageRequest,
  assertSessionPreviewRequestId,
  sessionPreviewAbortError
} from './workbench-kernel-helpers.ts'
import type {
  DetachedHistoryLease,
  PendingStaticSessionPreviewRequest,
  SessionPreviewRegistrySource,
  StaticSessionPreviewOperation
} from './workbench-kernel-types.ts'

/** What Session previews need from the Kernel. */
export type SessionPreviewsHost = {
  now(): number
  activeProjectKey(): string | null
  /** The configured project that previews are opened for. */
  configuredProjectPath(): string
  /** The Kernel's current in-memory registry, read lazily. */
  currentRegistry(): SessionPreviewRegistrySource
  /** The Kernel's cached pointer, else the one in the given registry. */
  findPointer(projectPath: string, sessionKey: string, registry: ProjectSessionRegistry): SessionPointer | undefined
  sessionValidator(): ((pointer: SessionPointer) => Promise<SessionPointer>) | undefined
  transcriptPreparations(): SessionTranscriptPreparationCache | null
}

const MAX_DETACHED_HISTORY_LEASES = 16

/**
 * Runtime-free Session previews: the static tail-then-full preview of a registered Session and
 * the leases that let detached previews page earlier history (moved from WorkbenchKernel, D-098).
 */
export class SessionPreviews {
  private readonly host: SessionPreviewsHost
  private pending: PendingStaticSessionPreviewRequest | null = null
  private active: StaticSessionPreviewOperation | null = null
  private readonly leases = new Map<string, DetachedHistoryLease>()

  constructor(host: SessionPreviewsHost) {
    this.host = host
  }

  async preview(
    sessionKey: string,
    requestId: string,
    sessionRegistry?: SessionPreviewRegistrySource
  ): Promise<KernelSessionPreview> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    assertSessionPreviewRequestId(requestId)
    const pending = this.pending
    if (pending !== null) {
      this.pending = null
      pending.controller.abort()
    }

    const request: PendingStaticSessionPreviewRequest = {
      requestId,
      controller: new AbortController()
    }
    this.pending = request
    let operation: StaticSessionPreviewOperation | null = null
    try {
      operation = await this.prepare(sessionKey, sessionRegistry, request)
      return await operation.tail
    } catch (error) {
      const stillOwnsPendingRequest = this.pending === request
      if (stillOwnsPendingRequest) this.pending = null
      if (operation !== null && this.active === operation) {
        this.active = null
      }
      request.controller.abort()
      if (operation === null && stillOwnsPendingRequest) this.cancelActive()
      throw error
    }
  }

  async complete(requestId: string): Promise<KernelSessionPreview> {
    assertSessionPreviewRequestId(requestId)
    const operation = this.active
    if (operation === null || operation.requestId !== requestId) {
      throw new Error('Session preview request is not active.')
    }
    try {
      return await operation.completion
    } finally {
      if (this.active === operation) this.active = null
    }
  }

  cancel(requestId: string): void {
    assertSessionPreviewRequestId(requestId)
    const pending = this.pending
    if (pending !== null && pending.requestId === requestId) {
      this.pending = null
      pending.controller.abort()
      return
    }
    const operation = this.active
    if (operation === null || operation.requestId !== requestId) return
    this.active = null
    this.cancelOperation(operation)
  }

  async loadEarlier(
    request: KernelSessionPreviewPageRequest,
    sessionRegistry?: SessionPreviewRegistrySource
  ): Promise<KernelConversationPage> {
    const lease = this.leases.get(request.previewId)
    if (
      lease === undefined ||
      lease.pointer.projectPath !== request.projectKey ||
      lease.pointer.sessionFile !== request.sessionKey ||
      lease.pointer.sessionId !== request.sessionId
    ) {
      throw new Error('Session preview page identity is stale.')
    }
    if (lease.archivedExpiresAt !== null) {
      if (this.host.now() >= lease.archivedExpiresAt) {
        this.leases.delete(request.previewId)
        throw new Error('Archived Session preview has expired.')
      }
    } else {
      const registrySource = sessionRegistry ?? this.host.currentRegistry()
      await this.assertIdentity(request.projectKey, lease.pointer, registrySource)
    }
    const preparations = this.host.transcriptPreparations()
    if (preparations === null) throw new Error('Session preview is unavailable.')
    const handle = await preparations.acquire(lease.pointer)
    try {
      const phase = await handle.completion
      const entries = projectTranscriptMessages(phase.messages)
      assertConversationPageRequest(request, entries)
      const startIndex = conversationTurnWindowStartIndex(
        entries,
        request.beforeIndex,
        KERNEL_CONVERSATION_PAGE_TURN_COUNT
      )
      if (startIndex >= request.beforeIndex) {
        throw new Error('Session preview has no earlier Conversation page.')
      }
      return {
        projectKey: request.projectKey,
        sessionKey: request.sessionKey,
        sessionId: request.sessionId,
        beforeIndex: request.beforeIndex,
        beforeEntryId: request.beforeEntryId,
        startIndex,
        entries: entries.slice(startIndex, request.beforeIndex)
      }
    } finally {
      handle.release()
    }
  }

  /** Let a detached preview page earlier history; archived previews expire. */
  rememberLease(previewId: string, pointer: SessionPointer, archivedExpiresAt: number | null): void {
    this.leases.set(previewId, { previewId, pointer, archivedExpiresAt })
    while (this.leases.size > MAX_DETACHED_HISTORY_LEASES) {
      const oldest = this.leases.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.leases.delete(oldest)
    }
  }

  clearLeases(): void {
    this.leases.clear()
  }

  cancelActive(): void {
    const pending = this.pending
    if (pending !== null) {
      this.pending = null
      pending.controller.abort()
    }
    const operation = this.active
    if (operation !== null) {
      this.active = null
      this.cancelOperation(operation)
    }
  }

  private async prepare(
    sessionKey: string,
    sessionRegistry: SessionPreviewRegistrySource | undefined,
    request: PendingStaticSessionPreviewRequest
  ): Promise<StaticSessionPreviewOperation> {
    const projectPath = this.host.configuredProjectPath()
    const registrySource = sessionRegistry ?? this.host.currentRegistry()
    const registry = await resolveRegistry(registrySource)
    this.assertPending(request)
    if (this.host.activeProjectKey() !== projectPath) {
      throw new Error('Session preview cancelled because the active project changed.')
    }
    const storedPointer = this.host.findPointer(projectPath, sessionKey, registry)
    if (storedPointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }
    const validateSession = this.host.sessionValidator()
    if (typeof validateSession !== 'function') {
      throw new Error('Session validation is unavailable.')
    }
    const preparations = this.host.transcriptPreparations()
    if (preparations === null) throw new Error('Session preview is unavailable.')

    const pointer = await validateSession(storedPointer)
    this.assertPending(request)
    await this.assertIdentity(projectPath, pointer, registrySource)
    this.assertPending(request)
    const preparation = await preparations.acquire(pointer)
    this.assertPending(request)

    let resolveTail!: (preview: KernelSessionPreview) => void
    let rejectTail!: (error: unknown) => void
    const tail = new Promise<KernelSessionPreview>((resolve, reject) => {
      resolveTail = resolve
      rejectTail = reject
    })
    const operation: StaticSessionPreviewOperation = {
      requestId: request.requestId,
      previewId: randomUUID(),
      projectPath,
      pointer,
      registrySource,
      controller: request.controller,
      preparation,
      tail,
      resolveTail,
      rejectTail,
      completion: Promise.resolve(null as unknown as KernelSessionPreview)
    }
    const previous = this.active
    this.pending = null
    this.active = operation
    this.rememberLease(operation.previewId, pointer, null)
    if (previous !== null) this.cancelOperation(previous)
    operation.completion = this.run(operation)
    void operation.completion.catch(() => undefined)
    return operation
  }

  private assertPending(request: PendingStaticSessionPreviewRequest): void {
    if (this.pending !== request || request.controller.signal.aborted) {
      throw sessionPreviewAbortError()
    }
  }

  private async run(operation: StaticSessionPreviewOperation): Promise<KernelSessionPreview> {
    try {
      const tail = await operation.preparation.tail
      await this.assertBoundary(operation)
      operation.resolveTail(project(operation, tail, false))
      const full = await operation.preparation.completion
      await this.assertBoundary(operation)
      return project(operation, full, true)
    } catch (error) {
      operation.rejectTail(error)
      throw error
    } finally {
      operation.preparation.release()
    }
  }

  private async assertBoundary(operation: StaticSessionPreviewOperation): Promise<void> {
    if (this.active !== operation || operation.controller.signal.aborted) {
      throw sessionPreviewAbortError()
    }
    await this.assertIdentity(operation.projectPath, operation.pointer, operation.registrySource)
    if (this.active !== operation || operation.controller.signal.aborted) {
      throw sessionPreviewAbortError()
    }
  }

  private async assertIdentity(
    projectPath: string,
    pointer: SessionPointer,
    registrySource: SessionPreviewRegistrySource
  ): Promise<void> {
    if (this.host.activeProjectKey() !== projectPath) {
      throw new Error('Session preview cancelled because the active project changed.')
    }
    const registry = await resolveRegistry(registrySource)
    if (
      this.host.activeProjectKey() !== projectPath ||
      !registry.sessions.some((candidate) =>
        candidate.projectPath === projectPath &&
        candidate.sessionFile === pointer.sessionFile &&
        candidate.sessionId === pointer.sessionId
      )
    ) {
      throw new Error('Session preview cancelled because the Session identity changed.')
    }
  }

  private cancelOperation(operation: StaticSessionPreviewOperation): void {
    operation.controller.abort()
    operation.preparation.release()
    operation.rejectTail(sessionPreviewAbortError())
  }
}

function resolveRegistry(source: SessionPreviewRegistrySource): Promise<ProjectSessionRegistry> {
  return typeof source === 'function' ? source() : Promise.resolve(source)
}

function project(
  operation: StaticSessionPreviewOperation,
  phase: SessionTranscriptMessagePhase,
  boundCompletedPreview: boolean
): KernelSessionPreview {
  const entries = projectTranscriptMessages(phase.messages)
  const startIndex = boundCompletedPreview
    ? conversationTurnWindowStartIndex(entries, entries.length, KERNEL_CONVERSATION_PAGE_TURN_COUNT)
    : 0
  return {
    previewId: operation.previewId,
    projectKey: operation.projectPath,
    sessionKey: operation.pointer.sessionFile,
    sessionId: operation.pointer.sessionId,
    sessionName: operation.pointer.sessionName,
    conversation: {
      entries: entries.slice(startIndex),
      startIndex,
      activeRunStartIndex: null
    }
  }
}
