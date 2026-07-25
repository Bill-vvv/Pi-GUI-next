export function formatPathReference(path: string): string {
  if (path.length === 0) throw new Error('Path reference must not be empty.')
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
    throw new Error('Path reference contains unsupported control characters.')
  }
  return /[\s"\\]/u.test(path)
    ? `@"${path.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
    : `@${path}`
}
