import { constants, type BigIntStats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { KernelCommand, KernelPromptAttachment } from '../../shared/kernel-contract.ts'
import type { DesktopHostControlIdentity } from '../../shared/desktop-host-contract.ts'
import {
  DESKTOP_ATTACHMENT_CHUNK_BYTES, DESKTOP_ATTACHMENT_DRAFT_TTL_MS, DESKTOP_ATTACHMENT_MAX_COUNT,
  isDesktopAttachmentCommand, isDesktopUploadId, type DesktopAttachmentCommand, type DesktopUploadedAttachment
} from '../../shared/desktop-attachment-contract.ts'

export type DesktopAttachmentOwner = DesktopHostControlIdentity & { controllerId: string }
type Entry = {
  id: string; owner: DesktopAttachmentOwner; name: string; size: number; offset: number; expiresAt: number
  file: FileHandle; attachment: KernelPromptAttachment | null; digest: string | null; verifiedStat: BigIntStats | null
}
export class DesktopAttachmentError extends Error {}

const MAX_DRAFT_BYTES = 128 * 1024 * 1024

/** One Linux Host owns these drafts. Only submitted files outlive its controller or process. */
export class DesktopAttachmentStore {
  private readonly entries = new Map<string, Entry>()
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private cleanupError: unknown = null
  private closed = false
  private readonly root: string
  private readonly materialize: (path: string) => Promise<KernelPromptAttachment[]>
  private readonly now: () => number

  constructor(options: { root: string; materialize: (path: string) => Promise<KernelPromptAttachment[]>; now?: () => number }) {
    this.root = resolve(options.root)
    this.materialize = options.materialize
    this.now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    if (process.platform !== 'linux') throw new DesktopAttachmentError('Attachment storage requires Linux.')
    for (const path of [this.root, join(this.root, 'drafts'), join(this.root, 'submitted')]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      const info = await lstat(path)
      if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || await realpath(path) !== path) {
        throw new DesktopAttachmentError('Attachment storage must be a private canonical directory owned by the Host user.')
      }
    }
    // Host startup has no surviving controller; only this feature's UUID draft directories are removed.
    for (const name of await readdir(join(this.root, 'drafts'))) {
      if (!isDesktopUploadId(name)) throw new DesktopAttachmentError('Unexpected entry in attachment draft storage.')
      await rm(join(this.root, 'drafts', name), { recursive: true, force: true })
    }
    this.timer = setInterval(() => {
      void this.enqueue(() => this.expire()).catch((error: unknown) => { this.cleanupError = error })
    }, 60_000)
    this.timer.unref()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation, operation)
    this.tail = pending.then(() => undefined, () => undefined)
    return pending
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.enqueue(async () => {
      for (const entry of this.entries.values()) await this.removeDraft(entry)
      if (this.cleanupError) throw this.cleanupError
    })
  }

  private async removeDraft(entry: Entry): Promise<void> {
    await entry.file.close()
    await rm(join(this.root, 'drafts', entry.id), { recursive: true, force: true })
    this.entries.delete(entry.id)
  }

  private async expire(): Promise<void> {
    for (const entry of this.entries.values()) if (entry.expiresAt <= this.now()) await this.removeDraft(entry)
  }

  dispatch(command: DesktopAttachmentCommand, owner: DesktopAttachmentOwner, assertBoundary: () => Promise<void>,
    submit: (command: KernelCommand, assertBoundary: () => Promise<void>) => Promise<unknown>): Promise<unknown> {
    return this.enqueue(async () => {
      if (this.closed || this.cleanupError) throw new DesktopAttachmentError('Attachment storage is unavailable; restart the Host after checking storage permissions.')
      if (!isDesktopAttachmentCommand(command)) throw new DesktopAttachmentError('Invalid attachment command.')
      if (!owner.projectKey || !owner.sessionKey) throw new DesktopAttachmentError('Attachments require an active Project and Session.')
      await this.expire()
      await assertBoundary()
      const owned = (id: string): Entry => {
        const entry = this.entries.get(id)
        if (!entry || entry.owner.controllerId !== owner.controllerId || entry.owner.projectKey !== owner.projectKey ||
          entry.owner.sessionKey !== owner.sessionKey) throw new DesktopAttachmentError('Attachment expired, was submitted, or belongs to another controller or Session. Select the file again.')
        return entry
      }
      if (command.type === 'attachment.begin') {
        const entries = [...this.entries.values()]
        if (entries.length >= 64 || entries.filter((entry) => entry.owner.controllerId === owner.controllerId).length >= DESKTOP_ATTACHMENT_MAX_COUNT ||
          entries.reduce((total, entry) => total + entry.size, command.byteCount) > MAX_DRAFT_BYTES) throw new DesktopAttachmentError('Attachment draft quota exceeded. Remove drafts before uploading more files.')
        const id = randomUUID()
        const directory = join(this.root, 'drafts', id)
        await mkdir(directory, { mode: 0o700 })
        let file: FileHandle
        try { file = await open(join(directory, command.name), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600) }
        catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
        this.entries.set(id, { id, owner: { ...owner }, name: command.name, size: command.byteCount,
          offset: 0, expiresAt: this.now() + DESKTOP_ATTACHMENT_DRAFT_TTL_MS, file, attachment: null, digest: null, verifiedStat: null })
        return { uploadId: id }
      }
      if (command.type === 'attachment.discard') {
        for (const id of command.uploadIds) {
          if (!this.entries.has(id)) continue
          await this.removeDraft(owned(id))
        }
        return null
      }
      if (command.type === 'attachment.chunk') {
        const entry = owned(command.uploadId)
        const bytes = Buffer.from(command.data, 'base64')
        if (entry.attachment || command.offset !== entry.offset || bytes.toString('base64') !== command.data ||
          bytes.length > DESKTOP_ATTACHMENT_CHUNK_BYTES || entry.offset + bytes.length > entry.size) throw new DesktopAttachmentError('Attachment chunk is duplicated, out of order, or exceeds its declared size.')
        let written = 0
        while (written < bytes.length) {
          const result = await entry.file.write(bytes, written, bytes.length - written, entry.offset + written)
          if (result.bytesWritten === 0) throw new DesktopAttachmentError('Attachment write made no progress.')
          written += result.bytesWritten
        }
        entry.offset += bytes.length
        return { offset: entry.offset }
      }
      if (command.type === 'attachment.finish') {
        const entry = owned(command.uploadId)
        if (entry.offset !== entry.size) throw new DesktopAttachmentError('Attachment upload is incomplete.')
        if (entry.digest !== null && entry.digest !== command.sha256) throw new DesktopAttachmentError('Attachment checksum does not match.')
        if (!entry.attachment) {
          await entry.file.sync()
          await entry.file.chmod(0o400)
          const before = await entry.file.stat({ bigint: true })
          if (before.size !== BigInt(entry.size)) throw new DesktopAttachmentError('Attachment size changed in storage.')
          const hash = createHash('sha256')
          const buffer = Buffer.alloc(DESKTOP_ATTACHMENT_CHUNK_BYTES)
          let offset = 0
          while (offset < entry.size) {
            const { bytesRead } = await entry.file.read(buffer, 0, Math.min(buffer.length, entry.size - offset), offset)
            if (bytesRead === 0) throw new DesktopAttachmentError('Attachment became incomplete in storage.')
            hash.update(buffer.subarray(0, bytesRead))
            offset += bytesRead
          }
          const digest = hash.digest('hex')
          if (digest !== command.sha256) throw new DesktopAttachmentError('Attachment checksum does not match.')
          const attachments = entry.size === 0 ? [{ type: 'file' as const, name: entry.name, path: '' }]
            : await this.materialize(`/proc/self/fd/${entry.file.fd}`)
          if (attachments.length !== 1) throw new DesktopAttachmentError('Attachment could not be decoded.')
          const after = await entry.file.stat({ bigint: true })
          if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new DesktopAttachmentError('Attachment changed while being decoded.')
          }
          await assertBoundary()
          entry.attachment = { ...attachments[0]!, name: entry.name }
          entry.digest = digest
          entry.verifiedStat = after
        }
        return { type: 'uploaded', uploadId: entry.id, name: entry.name, byteCount: entry.size, kind: entry.attachment.type } satisfies DesktopUploadedAttachment
      }
      const entries = command.uploadIds.map(owned)
      if (entries.some((entry) => !entry.attachment)) throw new DesktopAttachmentError('Finish all attachments before submitting.')
      const attachments: KernelPromptAttachment[] = []
      const moved: string[] = []
      let dispatched = false
      try {
        for (const entry of entries) {
          const current = await entry.file.stat({ bigint: true })
          if (current.size !== entry.verifiedStat?.size || current.mtimeNs !== entry.verifiedStat.mtimeNs || current.ctimeNs !== entry.verifiedStat.ctimeNs) {
            throw new DesktopAttachmentError('Attachment changed in storage. Select the file again.')
          }
          const directory = join(this.root, 'submitted', entry.id)
          await rename(join(this.root, 'drafts', entry.id), directory)
          moved.push(directory)
          const path = join(directory, entry.name)
          if (await realpath(`/proc/self/fd/${entry.file.fd}`) !== path) throw new DesktopAttachmentError('Attachment file identity changed before submission.')
          attachments.push({ ...entry.attachment!, path })
        }
        await assertBoundary()
        // Claim once before dispatch. An error after dispatch may still mean the prompt landed.
        for (const entry of entries) this.entries.delete(entry.id)
        const kernelCommand: KernelCommand = command.mode === 'prompt'
          ? { type: 'kernel.prompt', message: command.message, attachments, expectedSessionKey: owner.sessionKey }
          : { type: command.mode === 'steer' ? 'kernel.steer' : 'kernel.follow-up', message: command.message, attachments }
        dispatched = true
        return await submit(kernelCommand, assertBoundary)
      } catch (error) {
        if (dispatched) throw new DesktopAttachmentError(
          'Attachment submission was not confirmed. Check the conversation before sending again; select attachments again if needed.', { cause: error })
        throw error
      } finally {
        for (const entry of entries) { this.entries.delete(entry.id); await entry.file.close() }
        if (!dispatched) {
          for (const path of moved) await rm(path, { recursive: true, force: true })
          for (const entry of entries) await rm(join(this.root, 'drafts', entry.id), { recursive: true, force: true })
        }
      }
    })
  }
}
