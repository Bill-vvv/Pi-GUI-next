import type { Notification } from 'electron'
import { DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS, type DesktopNotification } from '../notification/desktop-notification-broker.ts'

export function createElectronNotifications(NotificationClass: typeof Notification) {
  const active = new Map<Notification, () => void>()
  return {
    present(notification: DesktopNotification, onActivate: () => void, onDismiss: () => void): Promise<void> {
      if (!NotificationClass.isSupported()) return Promise.reject(new Error('Desktop notifications are unavailable on this client.'))
      if (active.size >= 128) return Promise.reject(new Error('Too many active desktop notifications.'))
      return new Promise((resolve, reject) => {
        const toast = new NotificationClass({ ...notification, timeoutType: 'default' })
        let accepted = false
        const acceptance = setTimeout(() => finish(new Error('Desktop notification was not accepted.')), 1_000)
        const lifetime = setTimeout(() => finish(), DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS)
        const finish = (error?: Error, notifyDismiss = true): void => {
          if (!active.delete(toast)) return
          clearTimeout(acceptance)
          clearTimeout(lifetime)
          toast.removeAllListeners()
          toast.close()
          if (notifyDismiss) onDismiss()
          if (!accepted) reject(error ?? new Error('Desktop notification closed before display.'))
        }
        // Client shutdown also closes the Host, which owns pending actions.
        // Do not race that teardown with a new remote dismissal request.
        active.set(toast, () => finish(undefined, false))
        toast.once('show', () => { accepted = true; clearTimeout(acceptance); resolve() })
        toast.once('failed', (_event, error) => finish(new Error(`Desktop notification failed: ${error}`)))
        toast.once('click', () => { onActivate(); finish() })
        toast.on('close', (event) => {
          // Windows keeps timed-out banners in Action Center. Their click action
          // must remain live until dismissal or the Host's action deadline.
          if (event.reason !== 'timedOut') finish()
        })
        try { toast.show() } catch (error) { finish(error instanceof Error ? error : new Error('Desktop notification failed.')) }
      })
    },
    close(): void {
      for (const close of active.values()) close()
    }
  }
}
