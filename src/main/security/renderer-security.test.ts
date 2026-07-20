import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { isAllowedRendererUrl, resolveRendererTarget } from './renderer-security.ts'

const rendererFilePath = '/opt/pi-gui/resources/app.asar/out/renderer/index.html'

test('a renderer URL inherited outside development mode is ignored', () => {
  const target = resolveRendererTarget({
    isPackaged: false,
    electronViteMode: 'preview',
    rendererUrl: 'https://attacker.example/application',
    rendererFilePath,
  })

  assert.deepEqual(target, {
    kind: 'bundled',
    url: pathToFileURL(rendererFilePath).href,
  })
})

test('packaged mode always selects the bundled renderer', () => {
  const target = resolveRendererTarget({
    isPackaged: true,
    electronViteMode: 'development',
    rendererUrl: 'not a URL',
    rendererFilePath,
  })

  assert.equal(target.kind, 'bundled')
})

test('development mode accepts HTTP and HTTPS loopback URLs', () => {
  for (const rendererUrl of ['http://localhost:5173', 'https://127.0.0.1:4173/', 'http://[::1]:5173']) {
    const target = resolveRendererTarget({
      isPackaged: false,
      electronViteMode: 'development',
      rendererUrl,
      rendererFilePath,
    })

    assert.equal(target.kind, 'development')
    assert.equal(target.url, new URL(rendererUrl).href)
  }
})

test('development mode rejects external hosts, credentials, and non-root entry URLs', () => {
  const rejectedUrls = [
    'https://example.com',
    'http://user:password@localhost:5173',
    'http://localhost:5173/app',
    'http://localhost:5173/?token=secret',
    'http://localhost:5173/#section',
  ]

  for (const rendererUrl of rejectedUrls) {
    assert.throws(() =>
      resolveRendererTarget({
        isPackaged: false,
        electronViteMode: 'development',
        rendererUrl,
        rendererFilePath,
      }),
    )
  }
})

test('development navigation allows the same origin and rejects another origin', () => {
  const target = resolveRendererTarget({
    isPackaged: false,
    electronViteMode: 'development',
    rendererUrl: 'http://localhost:5173',
    rendererFilePath,
  })

  assert.equal(isAllowedRendererUrl(target, 'http://localhost:5173/workbench?project=one#editor'), true)
  assert.equal(isAllowedRendererUrl(target, 'http://127.0.0.1:5173/workbench'), false)
  assert.equal(isAllowedRendererUrl(target, 'https://localhost:5173/workbench'), false)
  assert.equal(isAllowedRendererUrl(target, 'not a URL'), false)
})

test('bundled navigation allows only the same file pathname', () => {
  const target = resolveRendererTarget({
    isPackaged: true,
    electronViteMode: 'development',
    rendererUrl: 'http://localhost:5173',
    rendererFilePath,
  })

  assert.equal(isAllowedRendererUrl(target, `${pathToFileURL(rendererFilePath).href}?project=one#editor`), true)
  assert.equal(isAllowedRendererUrl(target, pathToFileURL('/opt/pi-gui/resources/app.asar/out/renderer/other.html').href), false)
  assert.equal(isAllowedRendererUrl(target, 'https://localhost/index.html'), false)
})
