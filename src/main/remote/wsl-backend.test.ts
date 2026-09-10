import assert from 'node:assert/strict'
import test from 'node:test'
import { mapWslAttachments, resolveWslFilePath } from './wsl-backend.ts'

test('Windows file attachments are mapped while Linux file selections retain their identity', async () => {
  const paths: string[] = []
  const command = await mapWslAttachments({
    type: 'kernel.prompt', message: 'Read both files', attachments: [
      { type: 'file', name: 'one.txt', path: 'D:\\space & 中文\\one.txt' },
      { type: 'file', name: 'two.txt', path: '/home/vvv/two.txt' }
    ]
  }, async (path) => { paths.push(path); return '/mnt/d/space & 中文/one.txt' })
  assert.deepEqual(paths, ['D:\\space & 中文\\one.txt'])
  assert.equal(command.type, 'kernel.prompt')
  if (command.type !== 'kernel.prompt') return
  assert.deepEqual(command.attachments?.map((attachment) => attachment.path), ['/mnt/d/space & 中文/one.txt', '/home/vvv/two.txt'])
})

test('WSL UNC paths stay in the selected distribution', async () => {
  assert.equal(await resolveWslFilePath('Ubuntu-24.04', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\vvv\\a.txt'), '/home/vvv/a.txt')
  await assert.rejects(resolveWslFilePath('Ubuntu-24.04', '\\\\wsl.localhost\\Debian\\home\\a.txt'), /different WSL distribution/)
  await assert.rejects(resolveWslFilePath('Ubuntu-24.04', 'relative.txt'), /absolute/)
})
