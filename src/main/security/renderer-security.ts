import { pathToFileURL } from 'node:url'

export type RendererTarget =
  | { kind: 'development'; url: string }
  | { kind: 'bundled'; url: string }

export interface ResolveRendererTargetOptions {
  isPackaged: boolean
  electronViteMode: string | undefined
  rendererUrl: string | undefined
  rendererFilePath: string
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

function normalizedHostname(url: URL): string {
  const { hostname } = url
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

function resolveDevelopmentUrl(rendererUrl: string | undefined): string {
  if (!rendererUrl) {
    throw new Error('rendererUrl is required in development mode')
  }

  let url: URL
  try {
    url = new URL(rendererUrl)
  } catch {
    throw new Error('rendererUrl must be a valid URL in development mode')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('rendererUrl must use http or https in development mode')
  }
  if (url.username || url.password) {
    throw new Error('rendererUrl must not contain credentials')
  }
  if (!LOOPBACK_HOSTNAMES.has(normalizedHostname(url))) {
    throw new Error('rendererUrl hostname must be localhost, 127.0.0.1, or ::1')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('rendererUrl must not contain a non-root path, query, or hash')
  }

  return url.href
}

export function resolveRendererTarget(options: ResolveRendererTargetOptions): RendererTarget {
  if (!options.isPackaged && options.electronViteMode === 'development') {
    return {
      kind: 'development',
      url: resolveDevelopmentUrl(options.rendererUrl),
    }
  }

  return {
    kind: 'bundled',
    url: pathToFileURL(options.rendererFilePath).href,
  }
}

export function isAllowedRendererUrl(target: RendererTarget, candidateUrl: string): boolean {
  try {
    const expected = new URL(target.url)
    const candidate = new URL(candidateUrl)

    if (target.kind === 'development') {
      return candidate.origin === expected.origin
    }

    return candidate.protocol === 'file:' && candidate.hostname === expected.hostname && candidate.pathname === expected.pathname
  } catch {
    return false
  }
}
