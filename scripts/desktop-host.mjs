import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { configureDesktopHost, inspectDesktopHost, startDesktopHost, lockDesktopHostDirectory } from '../src/main/remote/desktop-host-launch.ts'
import { deployDesktopHost, resolveInstalledDesktopHost, rollbackDesktopHost } from '../src/main/remote/desktop-host-deployment.ts'
import { packDesktopHost, installDesktopHostBundle } from '../src/main/remote/desktop-host-bundle.ts'

const usage = `Usage:
  node scripts/desktop-host.mjs configure [--port 18788] [--config-dir /absolute/directory]
  node scripts/desktop-host.mjs check --build-root /absolute/linux/build [--config-dir /absolute/directory]
  node scripts/desktop-host.mjs start --build-root /absolute/linux/build [--config-dir /absolute/directory]
  node scripts/desktop-host.mjs deploy --build-root /absolute/linux/build [--install-dir /absolute/directory]
  node scripts/desktop-host.mjs check|start|rollback [--install-dir /absolute/directory]
  node scripts/desktop-host.mjs pack --build-root /absolute/linux/build --output /absolute/host.tar.gz
  ./install.sh [--config-dir /absolute/directory] [--install-dir /absolute/directory] [--port 18788]

Requires a prepared Linux build and Node matching package.json. Start owns a foreground
Linux desktop; generate the pairing code in its Settings > Desktop Host (SSH).
Configure preserves existing machine tokens and paired-device records. No secrets are printed.`

try {
  const [command, ...args] = process.argv.slice(2)
  if (command === '--help' && args.length === 0) { console.log(usage) }
  else {
    const allowed = {
      configure: ['--port', '--config-dir', '--install-dir'],
      check: ['--config-dir', '--build-root', '--install-dir'],
      start: ['--config-dir', '--build-root', '--install-dir'],
      deploy: ['--config-dir', '--build-root', '--install-dir'],
      rollback: ['--config-dir', '--install-dir'],
      pack: ['--build-root', '--output'],
      install: ['--build-root', '--config-dir', '--install-dir', '--port']
    }
    if (!Object.hasOwn(allowed, command)) throw new Error(usage)
    const flags = new Map()
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1]
      if (!allowed[command].includes(key) || flags.has(key) || !value || value.startsWith('--')) throw new Error(usage)
      flags.set(key, value)
    }
    if (command === 'pack') {
      if (!flags.has('--build-root') || !flags.has('--output')) throw new Error(usage)
      console.log(JSON.stringify(await packDesktopHost({ buildRoot: flags.get('--build-root'), output: flags.get('--output'),
        onProgress: stage => console.error(`[Desktop Host] ${stage}`) }), null, 2))
    } else {
      const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
      if (!isAbsolute(base)) throw new Error('XDG_CONFIG_HOME must be absolute.')
      const directory = flags.get('--config-dir') ?? join(base, 'pi-gui-next')
      const data = process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share')
      if (!isAbsolute(data)) throw new Error('XDG_DATA_HOME must be absolute.')
      const installDirectory = flags.get('--install-dir') ?? join(data, 'pi-gui-next-host')
      if (command === 'install') {
        if (!flags.has('--build-root') || (flags.has('--port') && !/^[1-9][0-9]{0,4}$/u.test(flags.get('--port')))) throw new Error(usage)
        console.log(JSON.stringify(await installDesktopHostBundle({ buildRoot: flags.get('--build-root'), directory, installDirectory,
          port: flags.has('--port') ? Number(flags.get('--port')) : undefined,
          onProgress: stage => console.error(`[Desktop Host] ${stage}`) }), null, 2))
      } else if (command === 'configure') {
        if (flags.has('--build-root') || !/^[1-9][0-9]{0,4}$/u.test(flags.get('--port') ?? '18788')) throw new Error(usage)
        if (flags.has('--install-dir')) await resolveInstalledDesktopHost(directory, installDirectory)
        console.log(JSON.stringify({ configured: true, ...await configureDesktopHost(directory, Number(flags.get('--port') ?? '18788')) }, null, 2))
      } else {
        if (flags.has('--port')) throw new Error(usage)
        if (command === 'deploy') {
          if (!flags.has('--build-root')) throw new Error(usage)
          console.log(JSON.stringify(await deployDesktopHost({ directory, installDirectory, buildRoot: flags.get('--build-root'),
            onProgress: stage => console.error(`[Desktop Host] ${stage}`) }), null, 2))
        } else if (command === 'rollback') {
          if (flags.has('--build-root')) throw new Error(usage)
          console.log(JSON.stringify(await rollbackDesktopHost(directory, installDirectory), null, 2))
        } else if (command === 'check') {
          const lock = await lockDesktopHostDirectory(directory)
          try {
            const root = flags.get('--build-root') ?? await resolveInstalledDesktopHost(directory, installDirectory)
            console.log(JSON.stringify({ prepared: true, ...await inspectDesktopHost(directory, root) }, null, 2))
          } finally { await lock.close() }
        }
        else {
          const controller = new AbortController()
          const interrupt = () => controller.abort(new Error('Desktop Host launcher interrupted.'))
          process.once('SIGINT', interrupt)
          process.once('SIGTERM', interrupt)
          try {
            await startDesktopHost({ directory, buildRoot: flags.get('--build-root') ?? (() => resolveInstalledDesktopHost(directory, installDirectory)), signal: controller.signal,
              onReady: (status) => console.log(JSON.stringify({ ready: true, ...status }, null, 2)) })
          } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
        }
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
