import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import {
  createOperationLeaseController,
  installOperationLeaseProvider
} from './quiescence-provider.mjs'

const APP_NAME = 'Pi'
const ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '../assets/pi-notify.png')
const EXPIRE_TIME_MS = 12_000
const BROKER_TIMEOUT_MS = 2_500
const MAX_RESPONSE_BYTES = 4_096

type NotificationTarget = {
  projectPath: string
  sessionKey: string
}

type NotificationDelivery = 'gui-action' | 'desktop-only'

function notificationTitle(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const label = pi.getSessionName() || basename(ctx.cwd)
  return `Pi · ${label} · 已完成`
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined

  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`
}

function notificationBody(durationMs: number | undefined, actionable: boolean): string {
  const duration = formatDuration(durationMs)
  const status = duration
    ? `<b>✓ 任务已完成</b>  ·  用时 ${duration}`
    : '<b>✓ 任务已完成</b>'
  return `${status}\n${actionable ? '点击通知返回对应对话。' : '可以回来查看结果了。'}`
}

async function deliverNotification(
  title: string,
  actionableBody: string,
  desktopOnlyBody: string,
  ctx: ExtensionContext
): Promise<NotificationDelivery> {
  const target = notificationTarget(ctx)
  if (target !== null && await sendGuiNotification(title, actionableBody, target)) {
    return 'gui-action'
  }
  await sendDesktopNotification(title, desktopOnlyBody)
  return 'desktop-only'
}

function notificationTarget(ctx: ExtensionContext): NotificationTarget | null {
  let sessionKey: string | undefined
  try {
    sessionKey = ctx.sessionManager.getSessionFile()
  } catch {
    return null
  }
  if (!isAbsolute(ctx.cwd) || sessionKey === undefined || !isAbsolute(sessionKey)) return null
  return { projectPath: ctx.cwd, sessionKey }
}

function sendGuiNotification(
  title: string,
  body: string,
  target: NotificationTarget
): Promise<boolean> {
  const socketPath = process.env.PI_GUI_NOTIFICATION_SOCKET
  const token = process.env.PI_GUI_NOTIFICATION_TOKEN
  if (
    socketPath === undefined ||
    token === undefined ||
    !isAbsolute(socketPath) ||
    token.length < 32 ||
    token.length > 256
  ) {
    return Promise.resolve(false)
  }

  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    socket.setEncoding('utf8')
    socket.setTimeout(BROKER_TIMEOUT_MS)
    let output = ''
    let settled = false
    const finish = (result: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        version: 1,
        token,
        title,
        body,
        projectPath: target.projectPath,
        sessionKey: target.sessionKey
      })}\n`)
    })
    socket.on('data', (chunk: string) => {
      output += chunk
      if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) {
        finish(false)
        return
      }
      const newlineIndex = output.indexOf('\n')
      if (newlineIndex < 0) return
      try {
        const response: unknown = JSON.parse(output.slice(0, newlineIndex))
        finish(
          typeof response === 'object' &&
          response !== null &&
          !Array.isArray(response) &&
          (response as Record<string, unknown>).version === 1 &&
          (response as Record<string, unknown>).ok === true
        )
      } catch {
        finish(false)
      }
    })
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('end', () => finish(false))
  })
}

function sendDesktopNotification(title: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'notify-send',
      [
        '--app-name',
        APP_NAME,
        '--icon',
        ICON_PATH,
        '--app-icon',
        ICON_PATH,
        '--category',
        'transfer.complete',
        '--urgency',
        'normal',
        '--expire-time',
        String(EXPIRE_TIME_MS),
        title,
        body
      ],
      (error) => (error ? reject(error) : resolve())
    )
  })
}

export default function taskNotifyExtension(pi: ExtensionAPI) {
  let taskStartedAt: number | undefined
  const operationLease = createOperationLeaseController()
  installOperationLeaseProvider(pi.events, 'pi-gui-task-notify', operationLease)
  pi.on('session_start', () => {
    operationLease.startSession()
  })
  pi.on('session_shutdown', () => {
    operationLease.endSession()
  })

  const deliverTrackedNotification = async (
    title: string,
    actionableBody: string,
    desktopOnlyBody: string,
    ctx: ExtensionContext
  ): Promise<NotificationDelivery | null> => {
    const finish = operationLease.beginOperation()
    if (finish === null) return null
    try {
      return await deliverNotification(title, actionableBody, desktopOnlyBody, ctx)
    } finally {
      finish()
    }
  }

  pi.on('agent_start', () => {
    taskStartedAt ??= Date.now()
  })

  pi.on('agent_settled', async (_event, ctx) => {
    const durationMs = taskStartedAt === undefined ? undefined : Date.now() - taskStartedAt
    taskStartedAt = undefined

    // Avoid notifications from print/JSON automation while keeping TUI and RPC.
    if (!ctx.hasUI) return

    // agent_settled fires only after retries, compaction retries, and queued
    // continuations are finished. Notification failures never affect the run.
    await deliverTrackedNotification(
      notificationTitle(pi, ctx),
      notificationBody(durationMs, true),
      notificationBody(durationMs, false),
      ctx
    ).catch(() => undefined)
  })

  pi.registerCommand('task-notify-test', {
    description: 'Send a test task-completion desktop notification',
    handler: async (_args, ctx) => {
      try {
        const delivery = await deliverTrackedNotification(
          notificationTitle(pi, ctx),
          '<b>✓ 通知工作正常</b>\n点击通知返回当前对话。',
          '<b>✓ 通知工作正常</b>\n当前环境仅支持桌面提醒。',
          ctx
        )
        if (delivery === null) {
          ctx.ui.notify('Notification delivery is paused while this Runtime is hibernating.', 'warning')
          return
        }
        ctx.ui.notify(
          delivery === 'gui-action'
            ? 'Desktop notification sent; click it to return to this conversation.'
            : 'Desktop notification sent without a conversation action in this environment.',
          'info'
        )
      } catch (error) {
        ctx.ui.notify(
          `Desktop notification failed: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      }
    }
  })
}
