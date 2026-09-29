// Node Host entry (D-095), built as out/main/pi-host.js and run with the release's own Node:
//   node --use-env-proxy out/main/pi-host.js wsl            (WSL backend over the private stdio pipe)
//   node --use-env-proxy out/main/pi-host.js desktop-host   (foreground Desktop Host for SSH clients)
// It runs the same Host assembly as the Electron desktop without windows, dialogs or a display.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BUILD_IDENTITY_FILE_NAME, resolveBuildCommit } from '../build-identity.ts'
import { errorMessage } from '../utils/errors.ts'
import { startHostApplication, type HostApplication } from './host-application.ts'
import { hostLogDirectory, hostUserDataDirectory } from './host-paths.ts'

const mode = process.argv[2]
if (mode !== 'wsl' && mode !== 'desktop-host') {
  console.error('Usage: pi-host.js wsl|desktop-host')
  process.exit(2)
}
if (process.platform !== 'linux') {
  console.error('The Pi GUI Host runs on Linux.')
  process.exit(2)
}
if (mode === 'wsl') {
  // Stdout is exclusively the private parent pipe in WSL Host mode.
  console.log = console.error
  console.info = console.error
}

// Keep the Electron Main behaviour: a faulty callback is reported, not allowed to end every Session.
process.on('uncaughtException', (error) => {
  console.error(`[Pi GUI] Uncaught exception: ${error.stack ?? errorMessage(error)}`)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[Pi GUI] Unhandled rejection: ${reason instanceof Error ? reason.stack : errorMessage(reason)}`)
})

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(mainBundleDirectory, '../../package.json'), 'utf8')) as { version: string }
const userDataDirectory = hostUserDataDirectory()

let host: HostApplication | null = null
let shutdown: Promise<never> | null = null
function stop(code: number): Promise<never> {
  shutdown ??= (async () => {
    try {
      await host?.stop()
    } catch (error) {
      console.error(`[Pi GUI] Shutdown failed: ${errorMessage(error)}`)
      process.exit(1)
    }
    process.exit(code)
  })()
  return shutdown
}
process.on('SIGINT', () => { void stop(0) })
process.on('SIGTERM', () => { void stop(0) })

try {
  host = await startHostApplication({
    wslHostMode: mode === 'wsl',
    mainBundleDirectory,
    isPackaged: false,
    resourcesPath: '',
    userDataDirectory,
    logDirectory: hostLogDirectory(userDataDirectory),
    productVersion: packageJson.version,
    fetch: globalThis.fetch,
    resolveBuildCommit: () => resolveBuildCommit({ identityFilePath: join(mainBundleDirectory, BUILD_IDENTITY_FILE_NAME) }),
    desktop: null,
    onWslPipeClosed: () => { void stop(0) }
  })
  if (shutdown !== null) await shutdown
  if (mode === 'wsl') await host.serveWslPipe()
  await host.refreshSessionActivities()
  console.info(`[Pi GUI] Host ready (${mode}).`)
} catch (error) {
  console.error(`[Pi GUI] Startup failed: ${errorMessage(error)}`)
  if (host === null) process.exit(1)
  await stop(1)
}
