import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

export function systemFontCommand(platform: NodeJS.Platform, systemRoot?: string): { executable: string, args: string[] } {
  if (platform === 'linux') return { executable: 'fc-list', args: ['--format', '%{family[0]}\n'] }
  if (platform !== 'win32') throw new Error(`System font discovery is not supported on ${platform}.`)
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('SystemRoot is required for Windows font discovery.')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    'Add-Type -AssemblyName System.Drawing',
    '$fonts = New-Object System.Drawing.Text.InstalledFontCollection',
    'try { $fonts.Families | ForEach-Object { [Console]::WriteLine($_.Name) } } finally { $fonts.Dispose() }'
  ].join('\n')
  return {
    executable: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
  }
}

export async function listSystemFonts(): Promise<string[]> {
  const { executable, args } = systemFontCommand(process.platform, process.env.SystemRoot)
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, output) => {
      if (error !== null) reject(new Error(`Failed to list system fonts: ${error.message}`))
      else resolve(output)
    })
  })
  const fonts = [...new Set(stdout.split(/\r?\n/u).map((font) => font.trim()).filter(Boolean))].sort()
  if (fonts.length === 0) throw new Error('System font discovery returned no fonts.')
  return fonts
}
