import { spawn } from 'node:child_process'
import { join } from 'node:path'

import { DESKTOP_HOST_CREDENTIAL_PATTERN } from '../../shared/desktop-host-contract.ts'
import { isDesktopHostProfileId } from '../../shared/desktop-client-contract.ts'

export const DESKTOP_DEVICE_CREDENTIAL_TARGET = 'PiGUI/DesktopHost'

export function desktopHostProfileCredentialTarget(key: string): string {
  if (!isDesktopHostProfileId(key)) throw new Error('Invalid Host credential slot key.')
  return `${DESKTOP_DEVICE_CREDENTIAL_TARGET}/${key}`
}

export type DesktopDeviceCredentialStore = {
  save(credential: string): Promise<void>
  load(): Promise<string | null>
  clear(): Promise<void>
}

export function createMemoryDesktopDeviceCredentialStore(
  initial: string | null = null
): DesktopDeviceCredentialStore {
  let credential = initial
  return {
    async save(next) {
      assertDesktopHostCredential(next)
      credential = next
    },
    async load() {
      return credential
    },
    async clear() {
      credential = null
    }
  }
}

export function createWindowsCredentialManagerStore(options?: {
  target?: string
  powershellExecutable?: string
}): DesktopDeviceCredentialStore {
  const target = options?.target ?? DESKTOP_DEVICE_CREDENTIAL_TARGET
  if (!CREDENTIAL_TARGET_PATTERN.test(target)) {
    throw new Error('Windows Credential Manager target is invalid.')
  }
  const powershellExecutable = options?.powershellExecutable
  return {
    async save(credential) {
      assertDesktopHostCredential(credential)
      await runCredentialCommand('save', target, credential, powershellExecutable)
    },
    async load() {
      const result = await runCredentialCommand('load', target, null, powershellExecutable)
      if (result === null) return null
      assertDesktopHostCredential(result)
      return result
    },
    async clear() {
      await runCredentialCommand('clear', target, null, powershellExecutable)
    }
  }
}

export function assertDesktopHostCredential(credential: string): void {
  if (!DESKTOP_HOST_CREDENTIAL_PATTERN.test(credential)) {
    throw new Error('Desktop Host credential must contain 32 to 256 base64url characters.')
  }
}

const CREDENTIAL_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u
const POWERSHELL_TIMEOUT_MS = 20_000
const MAX_POWERSHELL_OUTPUT_CHARS = 8 * 1024

const CREDENTIAL_MANAGER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$Action = $env:PI_GUI_CRED_ACTION
$Target = $env:PI_GUI_CRED_TARGET
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PiGuiCred {
  public const uint CRED_TYPE_GENERIC = 1;
  public const uint CRED_PERSIST_LOCAL_MACHINE = 2;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@
function Fail([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}
if ($Action -eq 'save') {
  $secret = [Console]::In.ReadToEnd().TrimEnd([char]13, [char]10)
  $bytes = [Text.Encoding]::Unicode.GetBytes($secret)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $cred = New-Object PiGuiCred+CREDENTIAL
    $cred.Type = [PiGuiCred]::CRED_TYPE_GENERIC
    $cred.TargetName = $Target
    $cred.UserName = 'pi-gui-next'
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.CredentialBlob = $blob
    $cred.Persist = [PiGuiCred]::CRED_PERSIST_LOCAL_MACHINE
    if (-not [PiGuiCred]::CredWrite([ref]$cred, 0)) {
      Fail ('cred-write:' + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
  } finally {
    [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $bytes.Length), 0, $blob, $bytes.Length)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
  exit 0
}
if ($Action -eq 'load') {
  $ptr = [IntPtr]::Zero
  if (-not [PiGuiCred]::CredRead($Target, [PiGuiCred]::CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { exit 2 }
    Fail ('cred-read:' + $err)
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][PiGuiCred+CREDENTIAL])
    $byteCount = [int]$cred.CredentialBlobSize
    if ($byteCount -le 0) { Fail 'empty-secret' }
    $bytes = New-Object byte[] $byteCount
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $byteCount)
    $secret = [Text.Encoding]::Unicode.GetString($bytes).TrimEnd([char]0)
    [Console]::Out.Write($secret)
  } finally {
    [PiGuiCred]::CredFree($ptr)
  }
  exit 0
}
if ($Action -eq 'clear') {
  if (-not [PiGuiCred]::CredDelete($Target, [PiGuiCred]::CRED_TYPE_GENERIC, 0)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -ne 1168) { Fail ('cred-delete:' + $err) }
  }
  exit 0
}
Fail 'unsupported-action'
`.trim()

async function runCredentialCommand(
  action: 'save' | 'load' | 'clear',
  target: string,
  secret: string | null,
  powershellExecutable?: string
): Promise<string | null> {
  const executable = powershellExecutable ?? resolveWindowsPowershellExecutable()
  const encoded = Buffer.from(CREDENTIAL_MANAGER_SCRIPT, 'utf16le').toString('base64')
  const child = spawn(
    executable,
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    {
      env: {
        ...process.env,
        PI_GUI_CRED_ACTION: action,
        PI_GUI_CRED_TARGET: target
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.length > MAX_POWERSHELL_OUTPUT_CHARS) {
      child.kill()
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (stderr.length > MAX_POWERSHELL_OUTPUT_CHARS) {
      child.kill()
    }
  })
  if (secret !== null) {
    child.stdin.write(secret)
  }
  child.stdin.end()
  const exitCode = await waitForProcessExit(child, POWERSHELL_TIMEOUT_MS)
  if (exitCode === 2 && action === 'load') return null
  if (exitCode !== 0) {
    throw new Error(
      `Windows Credential Manager ${action} failed${stderr.trim().length > 0 ? `: ${stderr.trim()}` : '.'}`
    )
  }
  if (action !== 'load') return null
  const loaded = stdout.replace(/[\r\n]/gu, '')
  return loaded.length === 0 ? null : loaded
}

function resolveWindowsPowershellExecutable(): string {
  if (process.platform !== 'win32') {
    throw new Error('Windows Credential Manager is only available on Windows.')
  }
  const systemRoot = process.env.SystemRoot
  if (typeof systemRoot !== 'string' || systemRoot.length === 0) {
    throw new Error('Windows Credential Manager requires SystemRoot to locate PowerShell.')
  }
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Windows Credential Manager helper timed out.'))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}
