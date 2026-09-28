import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../App'
import { createPreviewKernelApi, createPreviewRemoteAdminApi } from '../../preview/create-preview-kernel-api'
import { DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../../../shared/desktop-host-contract'
import { DESKTOP_ATTACHMENT_COMMAND_TYPES, type DesktopAttachmentData, type DesktopUploadedAttachment } from '../../../../shared/desktop-attachment-contract'
import type { DesktopClientStatus } from '../../../../shared/desktop-client-contract'
import '../../tokens.css'
import '../../styles.css'

export async function runRemoteAttachmentChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = { gui: window.piGui, remote: window.piRemote, desktop: window.piDesktopClient }
  const preview = createPreviewKernelApi()
  window.piGui = { ...preview, selectPromptAttachments: async () => { throw new Error('Remote selection used local Kernel paths') },
    getPathForFile: () => { throw new Error('Remote DOM files must use bounded bytes') } }
  window.piRemote = createPreviewRemoteAdminApi()
  let status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'connected', hasStoredCredential: true, lastHost: null,
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES },
    error: null, failureKind: null, recovery: null
  }
  const listeners = new Set<(value: DesktopClientStatus) => void>()
  const pending: Array<{ id: string; files?: DesktopAttachmentData[]; resolve: (value: DesktopUploadedAttachment[]) => void; reject: (error: Error) => void }> = []
  const cancelled: string[] = []
  const discarded: string[][] = []
  const submitted: Array<{ mode: string; message: string; ids: string[] }> = []
  let notifyUpload: (() => void) | undefined
  const select = (id: string, files?: DesktopAttachmentData[]) => new Promise<DesktopUploadedAttachment[]>((resolve, reject) => {
    pending.push({ id, files, resolve, reject })
    notifyUpload?.()
  })
  window.piDesktopClient = {
    getStatus: async () => status, setControlIdentity: () => {},
    subscribeStatus: (listener: (value: DesktopClientStatus) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    selectAttachments: select, uploadAttachments: select,
    cancelAttachmentUpload: async (id: string) => { cancelled.push(id) },
    discardAttachments: async (ids: string[]) => { discarded.push(ids) },
    submitAttachments: async (mode: string, message: string, ids: string[]) => {
      submitted.push({ mode, message, ids })
      return preview.prompt(message)
    }
  } as unknown as Window['piDesktopClient']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const run = async (callback: () => void) => { await act(async () => { callback() }) }
  const frame = async () => { await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) }) }
  const take = async () => {
    if (pending.length === 0) {
      // File.arrayBuffer() completes independently of React and animation frames.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { notifyUpload = undefined; reject(new Error('No upload reached the desktop bridge')) }, 5_000)
        notifyUpload = () => { clearTimeout(timer); notifyUpload = undefined; resolve() }
      })
    }
    const next = pending.shift()
    check(next, 'No upload reached the desktop bridge')
    return next!
  }
  const ref = (name = '中文 文档.txt', kind: 'file' | 'image' = 'file'): DesktopUploadedAttachment => ({
    type: 'uploaded', uploadId: crypto.randomUUID(), name, byteCount: 4, kind
  })
  const picker = () => container.querySelector<HTMLButtonElement>('.composer-attach-action')!
  const chips = () => container.querySelectorAll('.composer-attachment')
  const choose = async () => { check(picker() && !picker().disabled, 'Attachment picker is unavailable'); await run(() => picker().click()); await frame(); return take() }
  try {
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await frame()
    const first = await choose()
    const documentRef = ref()
    await run(() => first.resolve([documentRef]))
    check(chips().length === 1 && chips()[0]!.textContent?.includes('已上传'), 'Uploaded file did not become a draft chip')
    const bounds = chips()[0]!.getBoundingClientRect()
    check(bounds.left >= 0 && bounds.right <= window.innerWidth, 'Attachment chip overflows the viewport')
    check(!container.textContent?.includes(documentRef.uploadId), 'Opaque upload identity leaked into user text')
    checks.push('Complete App selects a remote attachment through Desktop Main and displays an uploaded draft')

    const send = container.querySelector<HTMLButtonElement>('.send-action[aria-label="发送"]')!
    check(send && !send.disabled, 'Attachment-only prompt cannot be sent')
    await run(() => send.click())
    await frame()
    check(submitted.length === 1 && submitted[0]!.mode === 'prompt' && submitted[0]!.ids[0] === documentRef.uploadId, 'Prompt did not submit its owned upload reference')
    check(chips().length === 0, 'Successful submission retained its attachment draft')
    checks.push('An attachment-only prompt submits opaque references and clears the draft after acknowledgement')

    const remove = await choose()
    const removedRef = ref('remove.txt')
    await run(() => remove.resolve([removedRef]))
    await run(() => container.querySelector<HTMLButtonElement>('.composer-attachment-remove')!.click())
    check(chips().length === 0 && discarded.at(-1)?.[0] === removedRef.uploadId, 'Removing a chip did not discard its Host draft')
    checks.push('Removing an uploaded attachment requests cleanup for that exact upload')

    const cancelledUpload = await choose()
    const cancelButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '取消上传')!
    check(cancelButton, 'Pending upload has no cancellation control')
    await run(() => cancelButton.click())
    await run(() => cancelledUpload.resolve([ref('late-cancel.txt')]))
    check(cancelled.includes(cancelledUpload.id) && chips().length === 0, 'Cancelled response restored an attachment')
    checks.push('Upload cancellation addresses its operation and discards a late successful response')

    const failed = await choose()
    await run(() => failed.reject(new Error('上传配额已满，请移除附件后重试。')))
    check(container.textContent?.includes('上传配额已满'), 'Upload failure was hidden')
    const retry = await choose()
    await run(() => retry.resolve([]))
    check(!container.textContent?.includes('上传配额已满') && chips().length === 0, 'Retry did not clear the prior upload error')
    checks.push('Upload errors stay visible and a cancelled native selection can be retried')

    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array([1, 2, 3, 4])], '截图.png', { type: 'image/png' }))
    await run(() => container.querySelector('form')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })))
    await frame()
    const dropped = await take()
    check(dropped.files?.[0]?.name === '截图.png' && dropped.files[0].data.length === 4, 'Dropped file did not use bounded byte transfer')
    const image = ref('截图.png', 'image')
    await run(() => dropped.resolve([image]))
    check(chips()[0]?.textContent?.includes('图片'), 'Uploaded image metadata is not visible')
    await run(() => container.querySelector<HTMLButtonElement>('.composer-attachment-remove')!.click())
    checks.push('Dropped images use the upload byte channel and show image metadata without a Windows path')

    const old = await choose()
    const state = (await preview.getState()).state
    const next = state.sessions.find((session) => session.key !== state.activeSessionKey)!
    check(next, 'Fixture needs a second Session')
    await act(async () => { await preview.activateSession(next.key) })
    await frame()
    await run(() => old.resolve([ref('old-session.txt')]))
    check(cancelled.includes(old.id) && chips().length === 0, 'Session navigation retained an old upload')
    checks.push('Session navigation cancels in-flight uploads and ignores previous-task references')

    const disconnected = await choose()
    await run(() => {
      status = { ...status, phase: 'reconnecting', capabilities: null }
      for (const listener of listeners) listener(status)
    })
    await run(() => disconnected.resolve([ref('old-host.txt')]))
    check(cancelled.includes(disconnected.id) && !picker() && chips().length === 0, 'Disconnect retained upload state')
    checks.push('Disconnect unmounts attachment controls and rejects late references')
    return checks
  } finally {
    await run(() => root.unmount())
    container.remove()
    window.piGui = original.gui
    window.piRemote = original.remote
    if (original.desktop === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original.desktop
  }
}
