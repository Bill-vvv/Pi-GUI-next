import { randomUUID } from 'node:crypto'
import { DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS, type DesktopNotification, type DesktopNotificationPresenter } from '../notification/desktop-notification-broker.ts'

export const WSL_DESKTOP_CHANNEL = 'pi-gui:wsl-desktop.command'
type WslDesktopCommand =
  | { type: 'environment.prepare-restart' }
  | { type: 'notification.show', id: string, title: string, body: string }
  | { type: 'notification.activate' | 'notification.dismiss', id: string }
  | { type: 'window.focus' }
type Send = (command: WslDesktopCommand) => Promise<unknown>

export function parseWslDesktopCommand(value: unknown): WslDesktopCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid WSL desktop command.')
  const command = value as Record<string, unknown>
  const count = Object.keys(command).length
  if (command.type === 'environment.prepare-restart' && count === 1) return { type: command.type }
  if (command.type === 'window.focus' && count === 1) return { type: 'window.focus' }
  if (typeof command.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(command.id)) throw new Error('Invalid WSL notification identity.')
  if ((command.type === 'notification.activate' || command.type === 'notification.dismiss') && count === 2) {
    return { type: command.type, id: command.id }
  }
  if (command.type !== 'notification.show' || count !== 4 ||
      typeof command.title !== 'string' || command.title.length > 256 ||
      typeof command.body !== 'string' || command.body.length > 2_048) throw new Error('Invalid WSL notification.')
  return { type: 'notification.show', id: command.id, title: command.title, body: command.body }
}

/** Linux retains the validated Session activation callback; only an opaque id crosses the pipe. */
export function createWslNotificationPresenter(send: Send): DesktopNotificationPresenter & { dispatch(value: unknown): void } {
  const callbacks = new Map<string, { activate(): void, expires: ReturnType<typeof setTimeout> }>()
  const forget = (id: string): void => {
    clearTimeout(callbacks.get(id)?.expires)
    callbacks.delete(id)
  }
  return {
    async present(notification, onActivate) {
      if (callbacks.size >= 128) throw new Error('Too many pending WSL notifications.')
      const id = randomUUID()
      const expires = setTimeout(() => forget(id), DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS)
      expires.unref()
      callbacks.set(id, { activate: onActivate, expires })
      try {
        await send({ type: 'notification.show', id, ...notification })
      } catch (error) {
        forget(id)
        throw error
      }
    },
    dispatch(value) {
      const command = parseWslDesktopCommand(value)
      if (command.type !== 'notification.activate' && command.type !== 'notification.dismiss') throw new Error('Unsupported WSL Host desktop command.')
      const callback = callbacks.get(command.id)
      forget(command.id)
      if (command.type === 'notification.dismiss') return
      if (callback === undefined) throw new Error('WSL notification is no longer active.')
      callback.activate()
    },
    close() {
      for (const id of callbacks.keys()) forget(id)
    }
  }
}

export function createWslDesktopClient(options: {
  send: Send
  present(notification: DesktopNotification, onActivate: () => void, onDismiss: () => void): Promise<void>
  focusWindow(): void
  onError(error: unknown): void
}) {
  return async (value: unknown): Promise<void> => {
    const command = parseWslDesktopCommand(value)
    if (command.type === 'window.focus') { options.focusWindow(); return }
    if (command.type !== 'notification.show') throw new Error('Unsupported WSL Client desktop command.')
    let finished = false
    const finish = (type: 'notification.activate' | 'notification.dismiss'): void => {
      if (finished) return
      finished = true
      void options.send({ type, id: command.id }).catch(options.onError)
    }
    await options.present(
      { title: command.title, body: command.body },
      () => finish('notification.activate'),
      () => finish('notification.dismiss')
    )
  }
}
