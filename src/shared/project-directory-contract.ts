export const PROJECT_DIRECTORY_ENTRY_LIMIT = 200
export const PROJECT_DIRECTORY_SCAN_LIMIT = 2_000
export const PROJECT_DIRECTORY_RESPONSE_BYTE_LIMIT = 512 * 1024

export type ProjectDirectoryListing =
  | {
      ok: true
      path: string
      parentPath: string | null
      entries: Array<{ name: string; path: string; symbolicLink: boolean }>
      truncated: boolean
      inaccessibleLinks: number
    }
  | {
      ok: false
      code: 'not-found' | 'not-directory' | 'access-denied' | 'invalid-path'
      message: string
    }
