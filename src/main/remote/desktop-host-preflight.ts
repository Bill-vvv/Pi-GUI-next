import { createServer } from 'node:net'

import {
  DESKTOP_HOST_CHECK_STAGES, parseDesktopClientHostConfig,
  type DesktopClientHostConfig, type DesktopHostCheckResult, type DesktopHostCheckStage
} from '../../shared/desktop-client-contract.ts'
import { DesktopHostClient, type DesktopHostClientOptions } from './desktop-host-client.ts'
import {
  startSystemSshTunnel, SystemSshStartupCleanupError,
  type StartSystemSshTunnelOptions, type SystemSshTunnel
} from './system-ssh-tunnel.ts'

export async function runDesktopHostCheck(options: {
  config: DesktopClientHostConfig
  compatibility: DesktopHostClientOptions['compatibility']
  signal: AbortSignal
  startTunnel?: (options: StartSystemSshTunnelOptions) => Promise<SystemSshTunnel>
  createClient?: (options: DesktopHostClientOptions) => DesktopHostClient
  checkPort?: (port: number, signal: AbortSignal) => Promise<void>
}): Promise<{ result: DesktopHostCheckResult; retainedTunnel: SystemSshTunnel | null }> {
  const config = parseDesktopClientHostConfig(options.config)
  const result: DesktopHostCheckResult = {
    config, checkedAt: new Date().toISOString(), outcome: 'failed', cleanupError: null,
    steps: DESKTOP_HOST_CHECK_STAGES.map((stage) => ({ stage, status: 'skipped', detail: null }))
  }
  let current: DesktopHostCheckStage = 'local-port'
  let activeTunnel: SystemSshTunnel | null = null
  const stage = (next: DesktopHostCheckStage): void => {
    options.signal.throwIfAborted()
    const previous = result.steps.find((step) => step.stage === current)!
    previous.status = 'passed'
    current = next
  }
  try {
    options.signal.throwIfAborted()
    await (options.checkPort ?? checkLocalPort)(config.localPort, options.signal)
    const client = (options.createClient ?? ((config) => new DesktopHostClient(config)))({
      localPort: config.localPort, compatibility: options.compatibility
    })
    activeTunnel = await (options.startTunnel ?? startSystemSshTunnel)({
      config, signal: options.signal, onStage: stage,
      verifyUnauthenticatedDesktopHost: async (signal) => {
        stage('host')
        await client.verifyCompatibility(AbortSignal.any([signal, options.signal]))
        options.signal.throwIfAborted()
        result.steps.find((step) => step.stage === 'host')!.status = 'passed'
      }
    })
    options.signal.throwIfAborted()
    if (!result.steps.every((step) => step.status === 'passed')) throw new Error('Host 检查阶段未全部完成。')
    if (activeTunnel.connectionSignal.aborted) throw new Error('SSH 隧道在检查完成前已断开。')
    result.outcome = 'passed'
  } catch (error) {
    if (error instanceof SystemSshStartupCleanupError) activeTunnel = error.tunnel
    result.outcome = options.signal.aborted ? 'cancelled' : 'failed'
    const failed = result.steps.find((step) => step.stage === current)!
    failed.status = options.signal.aborted ? 'skipped' : 'failed'
    failed.detail = options.signal.aborted ? '检查已取消。' : checkErrorMessage(error)
  } finally {
    if (activeTunnel !== null) {
      try { await activeTunnel.stop(); activeTunnel = null } catch (error) {
        result.outcome = 'failed'
        result.cleanupError = checkErrorMessage(error)
      }
    }
    if (result.outcome === 'passed' && options.signal.aborted) result.outcome = 'cancelled'
    result.checkedAt = new Date().toISOString()
  }
  return { result, retainedTunnel: activeTunnel }
}

export async function checkLocalPort(port: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.once('close', () => {
      if (signal.aborted) reject(signal.reason)
    })
    server.once('listening', () => server.close((error) => error ? reject(error) : resolve()))
    server.listen({ host: '127.0.0.1', port, exclusive: true, signal })
  })
  signal.throwIfAborted()
}

function checkErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message} ${error.errors.map(checkErrorMessage).join(' ')}`.slice(0, 8192)
  return (error instanceof Error ? error.message : String(error)).slice(0, 8192)
}
