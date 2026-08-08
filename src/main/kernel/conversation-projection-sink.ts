import type {
  KernelConversationEntry,
  KernelSubagentNoticeEntry,
  KernelToolEntry
} from '../../shared/kernel-contract.ts'

export interface ConversationProjectionSink {
  findById(id: string): KernelConversationEntry | undefined
  findTool(toolCallId: string): KernelToolEntry | undefined
  findSubagentRequest(requestId: string): KernelSubagentNoticeEntry | undefined
  hasSubagentRequestFor(runId: string, participantIndex: number | null): boolean
  removeSubagentSupervisorControlsFor(runId: string, participantIndex: number | null): void
  upsert(entry: KernelConversationEntry): void
  result(): KernelConversationEntry[]
}

export function createImmutableProjectionSink(
  entries: KernelConversationEntry[]
): ConversationProjectionSink {
  return new ImmutableProjectionSink(entries)
}

export function createHistoricalProjectionSink(): ConversationProjectionSink {
  return new HistoricalProjectionSink()
}

class ImmutableProjectionSink implements ConversationProjectionSink {
  private currentEntries: KernelConversationEntry[]

  constructor(entries: KernelConversationEntry[]) {
    this.currentEntries = entries
  }

  findById(id: string): KernelConversationEntry | undefined {
    return this.currentEntries.find((entry) => entry.id === id)
  }

  findTool(toolCallId: string): KernelToolEntry | undefined {
    return this.currentEntries.find(
      (entry): entry is KernelToolEntry =>
        entry.kind === 'tool' && entry.toolCallId === toolCallId
    )
  }

  findSubagentRequest(requestId: string): KernelSubagentNoticeEntry | undefined {
    return this.currentEntries.find(
      (entry): entry is KernelSubagentNoticeEntry =>
        isSubagentRequest(entry) && entry.coordination.requestId === requestId
    )
  }

  hasSubagentRequestFor(runId: string, participantIndex: number | null): boolean {
    return this.currentEntries.some((entry) =>
      isSubagentRequest(entry) &&
      sameCoordinationTarget(entry.coordination.runId, entry.coordination.participantIndex, runId, participantIndex)
    )
  }

  removeSubagentSupervisorControlsFor(
    runId: string,
    participantIndex: number | null
  ): void {
    const nextEntries = this.currentEntries.filter((entry) =>
      !isMatchingSupervisorControl(entry, runId, participantIndex)
    )
    if (nextEntries.length !== this.currentEntries.length) this.currentEntries = nextEntries
  }

  upsert(entry: KernelConversationEntry): void {
    const index = this.currentEntries.findIndex((candidate) => candidate.id === entry.id)
    if (index === -1) {
      this.currentEntries = [...this.currentEntries, entry]
      return
    }
    const nextEntries = this.currentEntries.slice()
    nextEntries[index] = entry
    this.currentEntries = nextEntries
  }

  result(): KernelConversationEntry[] {
    return this.currentEntries
  }
}

class HistoricalProjectionSink implements ConversationProjectionSink {
  // Coordination removals leave tombstones so repeated request/control pairs do
  // not compact and reindex the full history. result() compacts exactly once.
  private readonly currentEntries: Array<KernelConversationEntry | null> = []
  private readonly indexById = new Map<string, number>()
  private readonly toolIndexByCallId = new Map<string, number>()
  // These three indexes are the only extra historical indexes: successful
  // replies, control suppression, and concrete-request supersession respectively.
  private readonly requestIndexByRequestId = new Map<string, number>()
  private readonly requestCountByTarget = new Map<string, number>()
  private readonly supervisorControlIndexesByTarget = new Map<string, Set<number>>()

  findById(id: string): KernelConversationEntry | undefined {
    return this.entryAt(this.indexById.get(id))
  }

  findTool(toolCallId: string): KernelToolEntry | undefined {
    const entry = this.entryAt(this.toolIndexByCallId.get(toolCallId))
    return entry?.kind === 'tool' ? entry : undefined
  }

  findSubagentRequest(requestId: string): KernelSubagentNoticeEntry | undefined {
    const entry = this.entryAt(this.requestIndexByRequestId.get(requestId))
    return isSubagentRequest(entry) ? entry : undefined
  }

  hasSubagentRequestFor(runId: string, participantIndex: number | null): boolean {
    return (this.requestCountByTarget.get(coordinationTargetKey(runId, participantIndex)) ?? 0) > 0
  }

  removeSubagentSupervisorControlsFor(
    runId: string,
    participantIndex: number | null
  ): void {
    const targetKey = coordinationTargetKey(runId, participantIndex)
    const indexes = this.supervisorControlIndexesByTarget.get(targetKey)
    if (indexes === undefined) return
    for (const index of indexes) {
      const entry = this.currentEntries[index]
      if (entry === null || entry === undefined) continue
      this.unindexEntry(entry, index)
      this.currentEntries[index] = null
    }
  }

  upsert(entry: KernelConversationEntry): void {
    const existingIndex = this.indexById.get(entry.id)
    if (existingIndex === undefined) {
      const index = this.currentEntries.length
      this.currentEntries.push(entry)
      this.indexEntry(entry, index)
      return
    }

    const existing = this.currentEntries[existingIndex]
    if (existing !== null && existing !== undefined) this.unindexEntry(existing, existingIndex)
    this.currentEntries[existingIndex] = entry
    this.indexEntry(entry, existingIndex)
  }

  result(): KernelConversationEntry[] {
    return this.currentEntries.filter(
      (entry): entry is KernelConversationEntry => entry !== null
    )
  }

  private entryAt(index: number | undefined): KernelConversationEntry | undefined {
    if (index === undefined) return undefined
    return this.currentEntries[index] ?? undefined
  }

  private indexEntry(entry: KernelConversationEntry, index: number): void {
    this.indexById.set(entry.id, index)
    if (entry.kind === 'tool') this.toolIndexByCallId.set(entry.toolCallId, index)
    if (isSubagentRequest(entry)) {
      const requestId = entry.coordination.requestId
      this.requestIndexByRequestId.set(requestId, index)
      const targetKey = coordinationTargetKey(
        entry.coordination.runId,
        entry.coordination.participantIndex
      )
      this.requestCountByTarget.set(targetKey, (this.requestCountByTarget.get(targetKey) ?? 0) + 1)
      return
    }
    if (isSupervisorControl(entry)) {
      const targetKey = coordinationTargetKey(
        entry.coordination.runId,
        entry.coordination.participantIndex
      )
      const indexes = this.supervisorControlIndexesByTarget.get(targetKey) ?? new Set<number>()
      indexes.add(index)
      this.supervisorControlIndexesByTarget.set(targetKey, indexes)
    }
  }

  private unindexEntry(entry: KernelConversationEntry, index: number): void {
    if (this.indexById.get(entry.id) === index) this.indexById.delete(entry.id)
    if (entry.kind === 'tool' && this.toolIndexByCallId.get(entry.toolCallId) === index) {
      this.toolIndexByCallId.delete(entry.toolCallId)
    }
    if (isSubagentRequest(entry)) {
      const requestId = entry.coordination.requestId
      if (this.requestIndexByRequestId.get(requestId) === index) {
        this.requestIndexByRequestId.delete(requestId)
      }
      const targetKey = coordinationTargetKey(
        entry.coordination.runId,
        entry.coordination.participantIndex
      )
      const nextCount = (this.requestCountByTarget.get(targetKey) ?? 1) - 1
      if (nextCount === 0) this.requestCountByTarget.delete(targetKey)
      else this.requestCountByTarget.set(targetKey, nextCount)
      return
    }
    if (isSupervisorControl(entry)) {
      const targetKey = coordinationTargetKey(
        entry.coordination.runId,
        entry.coordination.participantIndex
      )
      const indexes = this.supervisorControlIndexesByTarget.get(targetKey)
      indexes?.delete(index)
      if (indexes?.size === 0) this.supervisorControlIndexesByTarget.delete(targetKey)
    }
  }
}

function isSubagentRequest(
  entry: KernelConversationEntry | null | undefined
): entry is KernelSubagentNoticeEntry & {
  noticeType: 'request'
  coordination: NonNullable<KernelSubagentNoticeEntry['coordination']> & { requestId: string }
} {
  return entry?.kind === 'subagent-notice' &&
    entry.noticeType === 'request' &&
    entry.coordination?.requestId !== null &&
    entry.coordination?.requestId !== undefined
}

function isSupervisorControl(
  entry: KernelConversationEntry | null | undefined
): entry is KernelSubagentNoticeEntry & {
  noticeType: 'control'
  coordination: NonNullable<KernelSubagentNoticeEntry['coordination']>
} {
  return entry?.kind === 'subagent-notice' &&
    entry.noticeType === 'control' &&
    entry.coordination?.reason === 'supervisor_request'
}

function isMatchingSupervisorControl(
  entry: KernelConversationEntry,
  runId: string,
  participantIndex: number | null
): boolean {
  return isSupervisorControl(entry) && sameCoordinationTarget(
    entry.coordination.runId,
    entry.coordination.participantIndex,
    runId,
    participantIndex
  )
}

function coordinationTargetKey(runId: string, participantIndex: number | null): string {
  return JSON.stringify([runId, participantIndex])
}

function sameCoordinationTarget(
  leftRunId: string,
  leftParticipantIndex: number | null,
  rightRunId: string,
  rightParticipantIndex: number | null
): boolean {
  return leftRunId === rightRunId && leftParticipantIndex === rightParticipantIndex
}
