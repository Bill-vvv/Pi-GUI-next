import { StringDecoder } from 'node:string_decoder'

import type { KernelProviderTestResult } from '../../shared/kernel-contract.ts'
import { resolvePiExecutable } from '../runtime/pi-executable.ts'
import { spawnPiCommand } from '../runtime/pi-spawn.ts'

const TEST_TIMEOUT_MS = 30_000
const MAX_STDOUT_BYTES = 64 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const TEST_PROMPT = '.'

export type ProviderConnectionTestOptions = {
  executablePath?: string
  providerId: string
  modelId: string
  cwd?: string
}

export async function testProviderConnection(
  options: ProviderConnectionTestOptions
): Promise<KernelProviderTestResult> {
  const providerId = validateArgument(options.providerId, 'Provider ID')
  const modelId = validateArgument(options.modelId, '模型 ID')
  const executable = resolvePiExecutable({ explicitPath: options.executablePath })
  const startedAt = Date.now()
  const args = [
    '--print',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--provider',
    providerId,
    '--model',
    modelId,
    '--thinking',
    'off',
    TEST_PROMPT
  ]

  return new Promise<KernelProviderTestResult>((resolveResult, rejectResult) => {
    let child: ReturnType<typeof spawnPiCommand>
    try {
      child = spawnPiCommand(executable, args, {
        cwd: options.cwd ?? process.cwd(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      rejectResult(new Error('无法启动 Pi Provider 连接测试。'))
      return
    }

    let stdoutBytes = 0
    let stderrBytes = 0
    let stderrChars = 0
    let stdoutHasContent = false
    let outputLimitExceeded: 'stdout' | 'stderr' | null = null
    let timedOut = false
    let settled = false
    const stderrDecoder = new StringDecoder('utf8')

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TEST_TIMEOUT_MS)

    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectResult(error)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (!stdoutHasContent && /\S/u.test(chunk.toString('utf8'))) stdoutHasContent = true
      if (stdoutBytes > MAX_STDOUT_BYTES && outputLimitExceeded === null) {
        outputLimitExceeded = 'stdout'
        child.kill('SIGKILL')
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      stderrChars += stderrDecoder.write(chunk).length
      if (stderrBytes > MAX_STDERR_BYTES && outputLimitExceeded === null) {
        outputLimitExceeded = 'stderr'
        child.kill('SIGKILL')
      }
    })

    child.once('error', () => {
      rejectOnce(new Error('无法启动 Pi Provider 连接测试。'))
    })

    child.once('close', (code, signal) => {
      if (settled) return
      clearTimeout(timer)
      stderrChars += stderrDecoder.end().length

      if (timedOut) {
        rejectOnce(new Error(`Pi Provider 连接测试在 ${TEST_TIMEOUT_MS} ms 后超时；stderr ${stderrChars} 字符。`))
        return
      }
      if (outputLimitExceeded !== null) {
        rejectOnce(new Error(`Pi Provider 连接测试的 ${outputLimitExceeded} 超出限制；stderr ${stderrChars} 字符。`))
        return
      }
      if (code !== 0) {
        const exit = code === null ? `信号 ${signal ?? 'unknown'}` : `退出码 ${code}`
        rejectOnce(new Error(`Pi Provider 连接测试失败（${exit}；stderr ${stderrChars} 字符）。`))
        return
      }
      if (!stdoutHasContent) {
        rejectOnce(new Error(`Pi Provider 连接测试未返回内容；stderr ${stderrChars} 字符。`))
        return
      }

      settled = true
      resolveResult({ provider: providerId, modelId, durationMs: Date.now() - startedAt })
    })
  })
}

function validateArgument(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} 无效。`)
  }
  return value
}
