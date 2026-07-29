const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
const MAX_EXTERNAL_URL_LENGTH = 4_096
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export function normalizeExternalUrl(value: string): string | null {
  return normalizeLinkTarget(value, false)
}

export function normalizeOpenTarget(value: string): string | null {
  return normalizeLinkTarget(value, true)
}

function normalizeLinkTarget(value: string, allowLocalFile: boolean): string | null {
  if (
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    return null
  }

  try {
    const url = allowLocalFile && value.startsWith('/') ? new URL(value, 'file://') : new URL(value)
    if (url.protocol === 'file:') {
      return allowLocalFile && url.hostname.length === 0 ? url.href : null
    }
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol) || url.username || url.password) return null
    if (url.protocol === 'mailto:' && url.pathname.length === 0) return null
    return url.href
  } catch {
    return null
  }
}
