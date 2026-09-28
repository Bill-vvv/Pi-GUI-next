import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, DESKTOP_ATTACHMENT_MAX_COUNT,
  isDesktopAttachmentName, isDesktopUploadedAttachment, isDesktopUploadId,
  type DesktopAttachmentCommand, type DesktopAttachmentData, type DesktopUploadedAttachment
} from '../../shared/desktop-attachment-contract.ts'
import { isDesktopHostControlIdentity, type DesktopHostControlIdentity } from '../../shared/desktop-host-contract.ts'

type AttachmentSender = (command: DesktopAttachmentCommand, identity: DesktopHostControlIdentity) => Promise<unknown>

export class WindowsAttachmentUploader {
  private active: { id: string; abort: AbortController } | null = null
  private readonly send: AttachmentSender | null

  constructor(send?: AttachmentSender) {
    this.send = send ?? null
  }

  cancel(operationId?: string): void {
    if (this.active && (operationId === undefined || this.active.id === operationId)) this.active.abort.abort(new Error('附件上传已取消。'))
  }

  async upload(operationId: string, identity: unknown,
    select: () => Promise<readonly (string | DesktopAttachmentData)[]>, send = this.send): Promise<DesktopUploadedAttachment[]> {
    if (send === null) throw new Error('附件上传缺少所属 Host 连接。')
    if (!isDesktopUploadId(operationId) || !isDesktopHostControlIdentity(identity) || !identity.projectKey || !identity.sessionKey) {
      throw new Error('附件上传需要当前项目与会话。')
    }
    if (this.active) throw new Error('另一次附件上传尚未结束。')
    const operation = { id: operationId, abort: new AbortController() }
    this.active = operation
    const signal = operation.abort.signal
    const uploadedIds: string[] = []
    try {
      const sources = await select()
      signal.throwIfAborted()
      if (sources.length > DESKTOP_ATTACHMENT_MAX_COUNT) throw new Error('每次最多选择 8 个附件。')
      const attachments: DesktopUploadedAttachment[] = []
      for (const source of sources) {
        signal.throwIfAborted()
        const file = typeof source === 'string' ? await open(source, 'r') : null
        try {
          const before = await file?.stat({ bigint: true })
          const name = typeof source === 'string' ? basename(source) : source.name
          const size = before ? Number(before.size) : (source as DesktopAttachmentData).data.byteLength
          if (before && !before.isFile()) throw new Error('只能上传普通文件。')
          if (!isDesktopAttachmentName(name)) throw new Error('附件名称包含不支持的字符或过长。')
          if (size > DESKTOP_ATTACHMENT_MAX_BYTES) throw new Error('单个附件不能超过 16 MiB。')
          const begin = await send({ type: 'attachment.begin', name, byteCount: size }, identity) as { uploadId?: unknown }
          if (!isDesktopUploadId(begin.uploadId)) throw new Error('Host 返回了无效的上传编号。')
          const uploadId = begin.uploadId
          uploadedIds.push(uploadId)
          signal.throwIfAborted()
          const hash = createHash('sha256')
          let offset = 0
          while (offset < size) {
            signal.throwIfAborted()
            let bytes: Uint8Array
            if (file) {
              const buffer = Buffer.alloc(Math.min(DESKTOP_ATTACHMENT_CHUNK_BYTES, size - offset))
              const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
              if (bytesRead === 0) throw new Error('上传期间文件已被截断，请重新选择。')
              bytes = buffer.subarray(0, bytesRead)
            } else bytes = (source as DesktopAttachmentData).data.subarray(offset, offset + DESKTOP_ATTACHMENT_CHUNK_BYTES)
            hash.update(bytes)
            const result = await send({ type: 'attachment.chunk', uploadId, offset, data: Buffer.from(bytes).toString('base64') }, identity) as { offset?: unknown }
            offset += bytes.byteLength
            if (result.offset !== offset) throw new Error('Host 确认的上传位置不正确。')
          }
          if (file && before) {
            const after = await file.stat({ bigint: true })
            if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
              after.ino !== before.ino || after.dev !== before.dev) throw new Error('上传期间文件已变化，请重新选择。')
          }
          signal.throwIfAborted()
          const result = await send({ type: 'attachment.finish', uploadId, sha256: hash.digest('hex') }, identity)
          if (!isDesktopUploadedAttachment(result) || result.uploadId !== uploadId || result.name !== name || result.byteCount !== size) {
            throw new Error('Host 返回的附件引用与所选文件不符。')
          }
          attachments.push(result)
        } finally { await file?.close() }
      }
      signal.throwIfAborted()
      return attachments
    } catch (error) {
      if (uploadedIds.length) {
        try { await send({ type: 'attachment.discard', uploadIds: uploadedIds }, identity) }
        catch (cleanupError) {
          throw new AggregateError([error, cleanupError], '附件上传未完成，远端清理未确认；未提交的文件将在过期后或 Host 重启时清理。')
        }
      }
      throw error
    } finally {
      if (this.active === operation) this.active = null
    }
  }
}
