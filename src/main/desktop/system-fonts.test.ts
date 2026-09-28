import assert from 'node:assert/strict'
import test from 'node:test'
import { listSystemFonts, systemFontCommand } from './system-fonts.ts'

test('Windows fonts come from System32 PowerShell instead of Linux or PATH', () => {
  const command = systemFontCommand('win32', 'C:\\Windows')
  assert.equal(command.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.match(Buffer.from(command.args.at(-1)!, 'base64').toString('utf16le'), /InstalledFontCollection/)
  assert.equal(systemFontCommand('linux').executable, 'fc-list')
  assert.throws(() => systemFontCommand('win32'), /SystemRoot/)
})

test('Windows discovers real installed fonts with the native helper', { skip: process.platform !== 'win32' }, async () => {
  const fonts = await listSystemFonts()
  assert.ok(fonts.length > 0)
  assert.ok(fonts.every((font) => typeof font === 'string' && font.length > 0))
})
