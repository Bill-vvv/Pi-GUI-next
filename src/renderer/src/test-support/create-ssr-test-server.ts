import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

/** Load real TSX for SSR assertions without opening browser services. */
export async function createSsrTestServer() {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    appType: 'custom',
    // SSR loads dependencies through Node; it needs no client dependency scan.
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, hmr: false, ws: false }
  })
  after(() => vite.close())
  return vite
}
