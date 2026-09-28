import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DesktopAttachmentCommand } from '../../shared/desktop-attachment-contract.ts'
import { WindowsAttachmentUploader } from './windows-attachment-uploader.ts'

const identity = { projectKey: '/project', sessionKey: 'session' }
function receiver() {
  const requests: DesktopAttachmentCommand[] = []
  const files = new Map<string, { name: string; bytes: Buffer[]; size: number }>()
  const send = async (command: DesktopAttachmentCommand, observed: unknown): Promise<unknown> => {
    assert.deepEqual(observed, identity)
    requests.push(command)
    if (command.type === 'attachment.begin') {
      const uploadId = randomUUID()
      files.set(uploadId, { name: command.name, size: command.byteCount, bytes: [] })
      return { uploadId }
    }
    if (command.type === 'attachment.chunk') {
      files.get(command.uploadId)!.bytes.push(Buffer.from(command.data, 'base64'))
      return { offset: command.offset + Buffer.from(command.data, 'base64').length }
    }
    if (command.type === 'attachment.finish') {
      const file = files.get(command.uploadId)!
      const bytes = Buffer.concat(file.bytes)
      assert.equal(command.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(file.size, bytes.length)
      return { type: 'uploaded', uploadId: command.uploadId, name: file.name, byteCount: bytes.length, kind: 'file' }
    }
    if (command.type === 'attachment.discard') { for (const id of command.uploadIds) files.delete(id); return null }
    assert.fail('Unexpected submit')
  }
  return { send, requests, files }
}

test('native file and clipboard bytes use bounded chunks, exact identity and complete checksums', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-upload-client-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, '中文 file.txt')
  await writeFile(path, '正文\n'.repeat(100_000))
  const host = receiver()
  const uploader = new WindowsAttachmentUploader(host.send)
  const refs = await uploader.upload(randomUUID(), identity, async () => [path, { name: 'empty', data: new Uint8Array() }])
  assert.equal(refs.length, 2)
  assert.equal(refs[0]!.name, '中文 file.txt')
  assert.equal(refs[1]!.byteCount, 0)
  assert.deepEqual(Buffer.concat(host.files.get(refs[0]!.uploadId)!.bytes), await readFile(path))
  assert.ok(host.requests.filter((command) => command.type === 'attachment.chunk').length > 1)
  assert.deepEqual(await uploader.upload(randomUUID(), identity, async () => []), [])
})

test('cancelling an in-flight upload discards its drafts without replay; old cancellation cannot affect a new operation', async () => {
  const host = receiver()
  let release!: () => void
  let started!: () => void
  const uploading = new Promise<void>((resolve) => { started = resolve })
  const pause = new Promise<void>((resolve) => { release = resolve })
  const uploader = new WindowsAttachmentUploader(async (command, observed) => {
    const result = await host.send(command, observed)
    if (command.type === 'attachment.chunk') { started(); await pause }
    return result
  })
  const id = randomUUID()
  const upload = uploader.upload(id, identity, async () => [{ name: 'file', data: new Uint8Array([1, 2, 3]) }])
  const rejected = assert.rejects(upload, /取消/)
  await uploading
  await assert.rejects(uploader.upload(randomUUID(), identity, async () => []), /尚未结束/)
  uploader.cancel(id)
  release()
  await rejected
  assert.equal(host.files.size, 0)
  assert.equal(host.requests.filter((command) => command.type === 'attachment.chunk').length, 1)
  const next = uploader.upload(randomUUID(), identity, async () => [{ name: 'next', data: new Uint8Array() }])
  uploader.cancel(id)
  assert.equal((await next).length, 1)
})

test('source changes and oversized selections reject without completing an upload', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-upload-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'file')
  await writeFile(path, 'before')
  const host = receiver()
  const uploader = new WindowsAttachmentUploader(async (command, observed) => {
    const result = await host.send(command, observed)
    if (command.type === 'attachment.chunk') await writeFile(path, 'changed content')
    return result
  })
  await assert.rejects(uploader.upload(randomUUID(), identity, async () => [path]), /文件已变化/)
  assert.equal(host.files.size, 0)
  await assert.rejects(uploader.upload(randomUUID(), identity, async () => [{ name: 'large', data: new Uint8Array(16 * 1024 * 1024 + 1) }]), /16 MiB/)
  assert.equal(host.requests.filter((command) => command.type === 'attachment.finish').length, 0)
})
