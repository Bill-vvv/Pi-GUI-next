import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { KernelCommand } from '../../shared/kernel-contract.ts'
import {
  DESKTOP_ATTACHMENT_DRAFT_TTL_MS, isDesktopAttachmentCommand, isDesktopAttachmentClientCommand,
  isDesktopUploadedAttachment, type DesktopAttachmentCommand, type DesktopUploadedAttachment
} from '../../shared/desktop-attachment-contract.ts'
import { materializePrompt } from '../prompt/prompt-attachments.ts'
import { DesktopAttachmentStore, type DesktopAttachmentOwner } from './desktop-attachment-store.ts'

const owner = { controllerId: randomUUID(), projectKey: '/project', sessionKey: 'session-A' }
const checksum = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-attachments-'))
  let now = 100
  const submitted: KernelCommand[] = []
  const store = new DesktopAttachmentStore({ root, now: () => now, materialize: async (path) => {
    const bytes = await readFile(path)
    return bytes[0] === 0x89 ? [{ type: 'image', name: 'ignored', path, hints: [], image: {
      type: 'image', mimeType: 'image/png', data: bytes.toString('base64')
    } }] : [{ type: 'file', name: 'ignored', path }]
  } })
  await store.start()
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const send = (command: DesktopAttachmentCommand, as: DesktopAttachmentOwner = owner, boundary = async () => {}) =>
    store.dispatch(command, as, boundary, async (value) => { submitted.push(value); return { revision: submitted.length } })
  const upload = async (name = '中文 file.txt', bytes = Buffer.from('body\n'), as = owner) => {
    const { uploadId } = await send({ type: 'attachment.begin', name, byteCount: bytes.length }, as) as { uploadId: string }
    if (bytes.length) await send({ type: 'attachment.chunk', uploadId, offset: 0, data: bytes.toString('base64') }, as)
    const result = await send({ type: 'attachment.finish', uploadId, sha256: checksum(bytes) }, as)
    assert.ok(isDesktopUploadedAttachment(result))
    return result
  }
  return { root, store, send, upload, submitted, advance: () => { now += DESKTOP_ATTACHMENT_DRAFT_TTL_MS + 1 } }
}

test('attachment commands never accept Host paths, extra fields, malformed chunks or repeated IDs', () => {
  const id = randomUUID()
  assert.ok(isDesktopAttachmentCommand({ type: 'attachment.begin', name: '中文 file.txt', byteCount: 0 }))
  for (const name of ['../private', '/etc/passwd', '..', 'bad\0name', 'a\\b', 'x'.repeat(241)]) {
    assert.equal(isDesktopAttachmentCommand({ type: 'attachment.begin', name, byteCount: 1 }), false)
  }
  assert.equal(isDesktopAttachmentCommand({ type: 'attachment.begin', name: 'ok', byteCount: 1, path: '/etc/passwd' }), false)
  assert.equal(isDesktopAttachmentCommand({ type: 'attachment.begin', name: 'ok', byteCount: 16 * 1024 * 1024 + 1 }), false)
  assert.equal(isDesktopAttachmentCommand({ type: 'attachment.chunk', uploadId: id, offset: 0, data: 'not base64!' }), false)
  assert.equal(isDesktopAttachmentCommand({ type: 'attachment.submit', uploadIds: [id, id], mode: 'prompt', message: '' }), false)
  assert.equal(isDesktopAttachmentClientCommand({ type: 'attachment.select-local', operationId: id, filePaths: ['/etc/passwd'] }), false)
  assert.ok(isDesktopAttachmentClientCommand({ type: 'attachment.upload-data', operationId: id, files: [{ name: 'empty', data: new Uint8Array() }] }))
})

test('Host uploads create opaque references, keep submitted files, and preserve native Pi image semantics', { skip: process.platform !== 'linux' }, async (t) => {
  const host = await fixture(t)
  const text = await host.upload()
  const image = await host.upload('截图.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  assert.equal(text.kind, 'file')
  assert.equal(image.kind, 'image')
  assert.ok(!JSON.stringify(text).includes(host.root))
  assert.deepEqual(await host.send({ type: 'attachment.finish', uploadId: text.uploadId, sha256: checksum(Buffer.from('body\n')) }), text)
  await host.send({ type: 'attachment.submit', mode: 'prompt', message: 'explain', uploadIds: [text.uploadId, image.uploadId] })
  const command = host.submitted[0]!
  assert.equal(command.type, 'kernel.prompt')
  if (command.type !== 'kernel.prompt') assert.fail('Expected prompt')
  assert.equal(command.expectedSessionKey, owner.sessionKey)
  assert.equal(command.attachments?.[0]?.name, text.name)
  const path = command.attachments![0]!.path
  assert.equal(await readFile(path, 'utf8'), 'body\n')
  const prompt = materializePrompt(command.message, command.attachments)
  assert.ok(prompt.message.includes('中文 file.txt'))
  assert.ok(!prompt.message.includes('body\n'), 'Ordinary file content must remain a path reference')
  assert.equal(prompt.images.length, 1)
  assert.equal(prompt.images[0]!.mimeType, 'image/png')
  await assert.rejects(host.send({ type: 'attachment.submit', mode: 'prompt', message: 'duplicate', uploadIds: [text.uploadId] }), /submitted/)
  assert.equal(host.submitted.length, 1)
  await host.store.close()
  assert.equal(await readFile(path, 'utf8'), 'body\n', 'Submitted references must survive Host shutdown')
})

test('Host upload ownership, offsets, hashes, cancellation and expiry fail closed', { skip: process.platform !== 'linux' }, async (t) => {
  const host = await fixture(t)
  const { uploadId } = await host.send({ type: 'attachment.begin', name: 'file', byteCount: 3 }) as { uploadId: string }
  await assert.rejects(host.send({ type: 'attachment.finish', uploadId, sha256: checksum(Buffer.from('abc')) }), /incomplete/)
  const chunk = { type: 'attachment.chunk' as const, uploadId, offset: 0, data: Buffer.from('abc').toString('base64') }
  await assert.rejects(host.send(chunk, { ...owner, sessionKey: 'session-B' }), /another controller or Session/)
  await assert.rejects(host.send(chunk, { ...owner, controllerId: randomUUID() }), /another controller or Session/)
  await host.send(chunk)
  await assert.rejects(host.send(chunk), /duplicated/)
  await assert.rejects(host.send({ type: 'attachment.finish', uploadId, sha256: checksum(Buffer.from('bad')) }), /checksum/)
  await host.send({ type: 'attachment.finish', uploadId, sha256: checksum(Buffer.from('abc')) })
  await assert.rejects(host.send({ type: 'attachment.submit', mode: 'steer', message: '', uploadIds: [uploadId] }, owner, async () => {
    throw new Error('revoked')
  }), /revoked/)
  assert.equal(host.submitted.length, 0)
  await host.send({ type: 'attachment.discard', uploadIds: [uploadId] })
  await host.send({ type: 'attachment.discard', uploadIds: [uploadId] })
  assert.deepEqual(await readdir(join(host.root, 'drafts')), [])
  const empty = await host.upload('empty', Buffer.alloc(0))
  host.advance()
  await assert.rejects(host.send({ type: 'attachment.submit', mode: 'follow-up', message: '', uploadIds: [empty.uploadId] }), /expired/)
  assert.deepEqual(await readdir(join(host.root, 'drafts')), [])
})

test('unconfirmed submission consumes references once and retains files for a potentially landed prompt', { skip: process.platform !== 'linux' }, async (t) => {
  const host = await fixture(t)
  const ref = await host.upload()
  let path = ''
  let calls = 0
  const submit = { type: 'attachment.submit' as const, mode: 'prompt' as const, message: '', uploadIds: [ref.uploadId] }
  await assert.rejects(host.store.dispatch(submit, owner, async () => {}, async (command) => {
    calls++
    if (command.type === 'kernel.prompt') path = command.attachments![0]!.path
    throw new Error('acknowledgement lost')
  }), /not confirmed/)
  assert.equal(await readFile(path, 'utf8'), 'body\n')
  await assert.rejects(host.send(submit), /submitted/)
  assert.equal(calls, 1)
})

test('draft quotas are enforced and storage refuses symlink roots', { skip: process.platform !== 'linux' }, async (t) => {
  const host = await fixture(t)
  for (let i = 0; i < 8; i++) await host.upload(`file-${i}`)
  await assert.rejects(host.upload('ninth'), /quota/)
  const link = `${host.root}-link`
  t.after(() => rm(link, { force: true }))
  await symlink(host.root, link)
  const store = new DesktopAttachmentStore({ root: link, materialize: async () => [] })
  await assert.rejects(store.start(), /private canonical/)
})

test('stored content is hashed from disk and later changes cannot be submitted', { skip: process.platform !== 'linux' }, async (t) => {
  const host = await fixture(t)
  const { uploadId } = await host.send({ type: 'attachment.begin', name: 'disk', byteCount: 3 }) as { uploadId: string }
  await host.send({ type: 'attachment.chunk', uploadId, offset: 0, data: Buffer.from('abc').toString('base64') })
  const path = join(host.root, 'drafts', uploadId, 'disk')
  await writeFile(path, 'bad')
  await assert.rejects(host.send({ type: 'attachment.finish', uploadId, sha256: checksum(Buffer.from('abc')) }), /checksum/)
  await host.send({ type: 'attachment.discard', uploadIds: [uploadId] })
  const ref = await host.upload()
  const readyPath = join(host.root, 'drafts', ref.uploadId, ref.name)
  await chmod(readyPath, 0o600)
  await writeFile(readyPath, 'tampered')
  await assert.rejects(host.send({ type: 'attachment.submit', mode: 'prompt', message: '', uploadIds: [ref.uploadId] }), /changed in storage/)
  assert.equal(host.submitted.length, 0)
  assert.deepEqual(await readdir(join(host.root, 'drafts')), [])
})
