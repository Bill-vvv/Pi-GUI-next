import type { KernelPromptAttachment } from './kernel-contract.ts'

export const DESKTOP_ATTACHMENT_CHANNEL = 'pi-gui:desktop-attachment'
export const DESKTOP_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024
export const DESKTOP_ATTACHMENT_CHUNK_BYTES = 256 * 1024
export const DESKTOP_ATTACHMENT_MAX_COUNT = 8
export const DESKTOP_ATTACHMENT_DRAFT_TTL_MS = 15 * 60 * 1000
export const DESKTOP_ATTACHMENT_COMMAND_TYPES = [
  'attachment.begin', 'attachment.chunk', 'attachment.finish', 'attachment.discard', 'attachment.submit'
] as const

/** A draft reference is not a Host file path and cannot be sent directly to the Kernel. */
export type DesktopUploadedAttachment = {
  type: 'uploaded'
  uploadId: string
  name: string
  byteCount: number
  kind: 'file' | 'image'
}
export type PromptDraftAttachment = KernelPromptAttachment | DesktopUploadedAttachment
export type DesktopAttachmentData = { name: string; data: Uint8Array }
export type DesktopAttachmentClientCommand =
  | { type: 'attachment.select-local'; operationId: string }
  | { type: 'attachment.upload-data'; operationId: string; files: DesktopAttachmentData[] }
  | { type: 'attachment.cancel-local'; operationId: string }
  | Extract<DesktopAttachmentCommand, { type: 'attachment.submit' | 'attachment.discard' }>
export type DesktopAttachmentCommand =
  | { type: 'attachment.begin'; name: string; byteCount: number }
  | { type: 'attachment.chunk'; uploadId: string; offset: number; data: string }
  | { type: 'attachment.finish'; uploadId: string; sha256: string }
  | { type: 'attachment.discard'; uploadIds: string[] }
  | { type: 'attachment.submit'; uploadIds: string[]; mode: 'prompt' | 'steer' | 'follow-up'; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
export function isDesktopUploadId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}
export function isDesktopAttachmentName(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && value.length > 0 &&
    new TextEncoder().encode(value).length <= 240 && !/[\\/\u0000-\u001f\u007f-\u009f]/u.test(value)
}
export function isDesktopAttachmentCommand(value: unknown): value is DesktopAttachmentCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const exact = (...keys: string[]) => Object.keys(input).length === keys.length && keys.every((key) => Object.hasOwn(input, key))
  if (input.type === 'attachment.begin') return exact('type', 'name', 'byteCount') && isDesktopAttachmentName(input.name) &&
    Number.isSafeInteger(input.byteCount) && Number(input.byteCount) >= 0 && Number(input.byteCount) <= DESKTOP_ATTACHMENT_MAX_BYTES
  if (input.type === 'attachment.chunk') return exact('type', 'uploadId', 'offset', 'data') && isDesktopUploadId(input.uploadId) &&
    Number.isSafeInteger(input.offset) && Number(input.offset) >= 0 && Number(input.offset) < DESKTOP_ATTACHMENT_MAX_BYTES &&
    typeof input.data === 'string' && input.data.length > 0 && input.data.length <= Math.ceil(DESKTOP_ATTACHMENT_CHUNK_BYTES / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(input.data)
  if (input.type === 'attachment.finish') return exact('type', 'uploadId', 'sha256') && isDesktopUploadId(input.uploadId) &&
    typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(input.sha256)
  if (input.type === 'attachment.discard' || input.type === 'attachment.submit') {
    if (!Array.isArray(input.uploadIds) || input.uploadIds.length === 0 || input.uploadIds.length > DESKTOP_ATTACHMENT_MAX_COUNT ||
      !input.uploadIds.every(isDesktopUploadId) || new Set(input.uploadIds).size !== input.uploadIds.length) return false
    return input.type === 'attachment.discard' ? exact('type', 'uploadIds') :
      exact('type', 'uploadIds', 'mode', 'message') && typeof input.mode === 'string' && ['prompt', 'steer', 'follow-up'].includes(input.mode) &&
      typeof input.message === 'string' && new TextEncoder().encode(input.message).length <= 256 * 1024
  }
  return false
}

export function isDesktopUploadedAttachment(value: unknown): value is DesktopUploadedAttachment {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return Object.keys(ref).length === 5 && ref.type === 'uploaded' && isDesktopUploadId(ref.uploadId) &&
    isDesktopAttachmentName(ref.name) && Number.isSafeInteger(ref.byteCount) && Number(ref.byteCount) >= 0 &&
    Number(ref.byteCount) <= DESKTOP_ATTACHMENT_MAX_BYTES && (ref.kind === 'file' || ref.kind === 'image')
}

export function isDesktopAttachmentClientCommand(value: unknown): value is DesktopAttachmentClientCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  if (input.type === 'attachment.submit' || input.type === 'attachment.discard') return isDesktopAttachmentCommand(value)
  if (!isDesktopUploadId(input.operationId)) return false
  if (input.type === 'attachment.select-local' || input.type === 'attachment.cancel-local') return Object.keys(input).length === 2
  return input.type === 'attachment.upload-data' && Object.keys(input).length === 3 && Array.isArray(input.files) &&
    input.files.length > 0 && input.files.length <= DESKTOP_ATTACHMENT_MAX_COUNT && input.files.every((file) =>
      file !== null && typeof file === 'object' && Object.keys(file).length === 2 && isDesktopAttachmentName(file.name) &&
      file.data instanceof Uint8Array && file.data.byteLength <= DESKTOP_ATTACHMENT_MAX_BYTES)
}
