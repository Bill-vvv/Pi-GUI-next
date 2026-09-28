import { useEffect, useRef, useState } from 'react'

import type {
  KernelArchiveReceipt, KernelMutationAck, KernelSessionPreview, KernelSessionPreviewPageRequest
} from '../../../../shared/kernel-contract'
import { mergeEarlierSessionPreviewPage } from '../../kernel/conversation-page-merge'
import { workbenchOp, type WorkbenchOperation } from '../../workbench-actions'

export type SessionOperationRunner = {
  mutation: <T extends KernelMutationAck>(action: WorkbenchOperation, operation: () => Promise<T>, exclusive?: boolean) => Promise<T>
  read: (action: WorkbenchOperation, operation: () => Promise<unknown>, exclusive?: boolean) => Promise<void>
}

type ArchiveNotification = {
  receipt: KernelArchiveReceipt
  expiresAt: number
  pending: 'undo' | 'preview' | null
}

type ArchivedSessionPreview = { preview: KernelSessionPreview; expiresAt: number }

type Options = {
  operations: SessionOperationRunner
  waitForRuntimeEnsureIdle: () => Promise<void>
  onArchived: (sessionKey: string) => void
  onPreviewOpened: () => void
}

/** Receipts, expiry and detached pages share one Session archive lifecycle. */
export function useSessionArchive(options: Options) {
  const notificationsRef = useRef<ArchiveNotification[]>([])
  const [archiveNotifications, setArchiveNotifications] = useState(notificationsRef.current)
  const previewRef = useRef<ArchivedSessionPreview | null>(null)
  const [archivedSessionPreview, setArchivedSessionPreview] = useState(previewRef.current)
  const previewRevision = useRef(0)
  const lifetime = useRef(0)

  function publishNotifications(next: ArchiveNotification[]): void {
    notificationsRef.current = next
    setArchiveNotifications(next)
  }

  function publishPreview(next: ArchivedSessionPreview | null): void {
    previewRef.current = next
    setArchivedSessionPreview(next)
  }

  function clearArchivedSessionPreview(): void {
    previewRevision.current += 1
    publishPreview(null)
  }

  useEffect(() => () => {
    lifetime.current += 1
    previewRevision.current += 1
    notificationsRef.current = []
    previewRef.current = null
  }, [])

  useEffect(() => {
    if (archiveNotifications.length === 0) return
    const expiresAt = Math.min(...archiveNotifications.map((entry) => entry.expiresAt))
    const timer = window.setTimeout(() => {
      publishNotifications(notificationsRef.current.filter((entry) => entry.expiresAt > Date.now()))
    }, Math.max(0, expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [archiveNotifications])

  useEffect(() => {
    if (archivedSessionPreview === null) return
    const timer = window.setTimeout(() => {
      // Expiry retires this displayed preview, not a newer pending preview request.
      if (previewRef.current === archivedSessionPreview) publishPreview(null)
    }, Math.max(0, archivedSessionPreview.expiresAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [archivedSessionPreview])

  async function archiveSession(sessionKey: string): Promise<void> {
    const generation = lifetime.current
    const result = await options.operations.mutation(workbenchOp('archive-session'), async () => {
      clearArchivedSessionPreview()
      await options.waitForRuntimeEnsureIdle()
      if (lifetime.current !== generation) throw new Error('Session archive lifecycle ended before dispatch.')
      return window.piGui.archiveSession(sessionKey)
    })
    if (lifetime.current !== generation) return
    publishNotifications([
      ...notificationsRef.current.filter(({ receipt }) => receipt.token !== result.receipt.token),
      { receipt: result.receipt, expiresAt: Date.now() + result.receipt.durationMs, pending: null }
    ])
    options.onArchived(sessionKey)
  }

  async function consumeReceipt(token: string, action: 'undo' | 'preview'): Promise<void> {
    const notification = notificationsRef.current.find((entry) => entry.receipt.token === token)
    if (notification === undefined || notification.pending !== null) return
    if (notification.expiresAt <= Date.now()) {
      publishNotifications(notificationsRef.current.filter((entry) => entry !== notification))
      return
    }
    const generation = lifetime.current
    // Claim synchronously so a second click cannot consume the same one-shot receipt.
    publishNotifications(notificationsRef.current.map((entry) => entry === notification
      ? { ...entry, pending: action } : entry))
    const revision = action === 'preview' ? ++previewRevision.current : previewRevision.current
    try {
      if (action === 'undo') {
        await options.operations.mutation(workbenchOp('undo-archive-session'), async () => {
          await options.waitForRuntimeEnsureIdle()
          if (lifetime.current !== generation || notification.expiresAt <= Date.now()) {
            throw new Error('归档撤销凭证已过期。')
          }
          return window.piGui.undoArchiveSession(token)
        }, false)
      } else {
        await options.operations.read(workbenchOp('preview-archived-session'), async () => {
          const preview = await window.piGui.previewArchivedSession(token)
          if (lifetime.current !== generation || previewRevision.current !== revision ||
            notification.expiresAt <= Date.now()) return
          options.onPreviewOpened()
          publishPreview({ preview, expiresAt: notification.expiresAt })
        }, false)
      }
    } finally {
      if (lifetime.current === generation) {
        publishNotifications(notificationsRef.current.filter((entry) => entry.receipt.token !== token))
      }
    }
  }

  async function loadEarlierArchivedPreview(): Promise<boolean> {
    const archived = previewRef.current
    if (archived === null) return false
    const firstEntry = archived.preview.conversation.entries[0]
    if (archived.expiresAt <= Date.now() || archived.preview.conversation.startIndex <= 0 || firstEntry === undefined) {
      throw new Error('当前归档预览没有可加载的更早内容。')
    }
    const revision = previewRevision.current
    const request: KernelSessionPreviewPageRequest = {
      previewId: archived.preview.previewId, projectKey: archived.preview.projectKey,
      sessionKey: archived.preview.sessionKey, sessionId: archived.preview.sessionId,
      beforeIndex: archived.preview.conversation.startIndex, beforeEntryId: firstEntry.id
    }
    const page = await window.piGui.loadEarlierSessionPreview(request)
    const current = previewRef.current
    if (previewRevision.current !== revision || current === null || current.expiresAt <= Date.now()) {
      throw new Error('Archived Session preview page response is stale.')
    }
    publishPreview({ ...current, preview: mergeEarlierSessionPreviewPage(current.preview, request, page) })
    return true
  }

  return {
    archiveNotifications, archivedSessionPreview, archiveSession, clearArchivedSessionPreview,
    loadEarlierArchivedPreview,
    undoArchive: (token: string) => consumeReceipt(token, 'undo'),
    previewArchivedSession: (token: string) => consumeReceipt(token, 'preview')
  }
}
