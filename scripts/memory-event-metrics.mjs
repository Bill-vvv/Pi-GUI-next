/**
 * Shared payload accounting for the release memory-event probe.
 * Keep replace-tool-metadata counting complete (expected + metadata).
 */

export function stringChars(value, visited = new Set()) {
  if (typeof value === 'string') return value.length
  if (value === null || typeof value !== 'object' || visited.has(value)) return 0
  visited.add(value)
  let chars = 0
  if (Array.isArray(value)) {
    for (const item of value) chars += stringChars(item, visited)
  } else {
    for (const item of Object.values(value)) chars += stringChars(item, visited)
  }
  return chars
}

/** Count the complete replace-tool-metadata patch payload. */
export function countReplaceToolMetadataPayloadChars(patch, countChars = stringChars) {
  return countChars(patch?.expected) + countChars(patch?.metadata)
}
