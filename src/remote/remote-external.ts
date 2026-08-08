import { normalizeExternalUrl } from '../shared/external-url.ts'

/** Browser-safe external open: http/https/mailto only; never file/local paths. */
export async function openRemoteExternal(url: string): Promise<void> {
  const normalized = normalizeExternalUrl(url)
  if (normalized === null) {
    throw new Error('Remote external links allow only http, https, and mailto targets.')
  }
  window.open(normalized, '_blank', 'noopener,noreferrer')
}
