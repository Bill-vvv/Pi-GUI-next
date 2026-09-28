import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { TestContext } from 'node:test'
import { createServer } from 'vite'

/** Run feature fixtures in real React/Chromium without launching the desktop application. */
export async function runBrowserChecks(t: TestContext, options: {
  fixture: string
  exportName: string
  expectedChecks: number
  viewport?: { width: number; height: number }
}): Promise<void> {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const cache = await mkdtemp(join(tmpdir(), 'pi-gui-browser-cache-'))
  const vite = await createServer({
    configFile: false, root, appType: 'custom', logLevel: 'error',
    // Concurrent fixtures have different dependency graphs; sharing Vite's
    // optimized-dependency directory can invalidate another running fixture.
    cacheDir: cache,
    esbuild: { jsx: 'automatic' },
    // Discover transitive dependencies from this fixture, not unrelated app/preview/build HTML.
    optimizeDeps: { entries: [options.fixture], include: ['react', 'react-dom/client'] },
    // hmr:false alone still creates Vite's WebSocket listener.
    server: { host: '127.0.0.1', port: 0, hmr: false, ws: false }
  })
  t.after(async () => {
    await vite.close()
    await rm(cache, { recursive: true, force: true })
  })
  vite.middlewares.use('/__react_lifecycle', (_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><html><body></body></html>')
  })
  await vite.listen()
  const origin = vite.resolvedUrls!.local[0]!
  const profile = await mkdtemp(join(tmpdir(), 'pi-gui-react-browser-'))
  const chrome = spawn(process.env.PI_GUI_TEST_BROWSER!, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, `${origin}__react_lifecycle`
  ], { stdio: 'ignore' })
  let spawnError: Error | null = null
  chrome.on('error', (error) => { spawnError = error })
  const exited = new Promise<void>((resolve) => chrome.once('close', () => resolve()))
  t.after(async () => {
    chrome.kill('SIGTERM')
    await exited
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })
  let port: string | undefined
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await delay(50)
    }
  }
  assert.ok(port, 'Chromium did not open its local debugging endpoint')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{
    type: string; webSocketDebuggerUrl: string
  }>
  const page = pages.find((entry) => entry.type === 'page')
  assert.ok(page)
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  t.after(() => socket.close())
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('Chromium connection failed')), { once: true })
  })
  let sequence = 0
  const requests = new Map<number, (message: { result: unknown; error?: unknown }) => void>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    requests.get(message.id)?.(message)
  })
  const send = (method: string, params: object = {}): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out`)) }, 45_000)
    requests.set(id, (message) => {
      clearTimeout(timer)
      requests.delete(id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Page.enable')
  if (options.viewport) await send('Emulation.setDeviceMetricsOverride', { ...options.viewport, deviceScaleFactor: 1, mobile: false })
  const loaded = new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (JSON.parse(String(event.data)).method !== 'Page.loadEventFired') return
      socket.removeEventListener('message', onMessage)
      resolve()
    }
    socket.addEventListener('message', onMessage)
  })
  await send('Page.navigate', { url: `${origin}__react_lifecycle` })
  await loaded
  const result = await send('Runtime.evaluate', {
    expression: `import(${JSON.stringify(`${origin}${options.fixture}`)}).then(m => m[${JSON.stringify(options.exportName)}]())`,
    awaitPromise: true, returnByValue: true
  }) as { result?: { value?: string[] }; exceptionDetails?: unknown }
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
  assert.equal(result.result?.value?.length, options.expectedChecks)
  for (const check of result.result!.value!) t.diagnostic(check)
}
