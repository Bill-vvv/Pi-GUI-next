import assert from 'node:assert/strict'
import test from 'node:test'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { linuxFileUrlToWindowsPath, mapWslAttachments, resolveWslFilePath } from './wsl-backend.ts'

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

test('WSL add-project and attachments accept only Linux paths on the host command', () => {
  assert.equal(isKernelCommand({ type: 'kernel.add-project' }), true)
  assert.equal(isKernelCommand({ type: 'kernel.add-project', projectPath: '/home/vvv/proj' }), true)
  assert.equal(isKernelCommand({ type: 'kernel.add-project', projectPath: 'D:\\proj' }), false)
  assert.equal(isKernelCommand({ type: 'kernel.select-prompt-attachments' }), true)
  assert.equal(
    isKernelCommand({ type: 'kernel.select-prompt-attachments', filePaths: ['/mnt/d/a.txt'] }),
    true
  )
  assert.equal(
    isKernelCommand({ type: 'kernel.select-prompt-attachments', filePaths: ['D:\\a.txt'] }),
    false
  )
  assert.equal(isKernelCommand({ type: 'kernel.export-session' }), true)
  assert.equal(isKernelCommand({ type: 'kernel.export-session', filePath: '/tmp/pi-session.html' }), true)
  assert.equal(isKernelCommand({ type: 'kernel.export-session', filePath: 'D:\\pi-session.html' }), false)
  assert.equal(isKernelCommand({ type: 'kernel.install-extension', kind: 'file' }), true)
  assert.equal(
    isKernelCommand({ type: 'kernel.install-extension', kind: 'directory', path: '/home/vvv/ext' }),
    true
  )
  assert.equal(
    isKernelCommand({ type: 'kernel.install-extension', kind: 'file', path: 'D:\\ext.ts' }),
    false
  )
})

test('WSL file links open on the Windows side of the selected distribution', () => {
  assert.equal(
    linuxFileUrlToWindowsPath('Ubuntu-24.04', 'file:///home/vvv/notes.md'),
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\vvv\\notes.md'
  )
  assert.equal(
    linuxFileUrlToWindowsPath('Ubuntu-24.04', 'file:///mnt/d/Projects/export.html'),
    'D:\\Projects\\export.html'
  )
  assert.throws(() => linuxFileUrlToWindowsPath('Ubuntu-24.04', 'https://example.com'), /local Linux path/)
})
