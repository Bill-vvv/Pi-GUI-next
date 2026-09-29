import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * The per-user data directory Electron uses for this unpacked app ("pi-gui-next") on Linux,
 * so the Node Host reads the same pairing, remote and attachment data (D-095).
 * Follows the ProjectStore rule: XDG_CONFIG_HOME when set, else ~/.config.
 */
export function hostUserDataDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  if (!isAbsolute(configHome)) throw new Error(`XDG config home must be absolute: ${configHome}`)
  return join(configHome, 'pi-gui-next')
}

/** Electron's app.getPath('logs') on Linux: <userData>/logs. */
export function hostLogDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, 'logs')
}
