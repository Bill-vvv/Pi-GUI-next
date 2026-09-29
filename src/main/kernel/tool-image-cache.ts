import type { KernelMessageImage } from '../../shared/kernel-contract.ts'
import type { RuntimeHost } from '../runtime/runtime-host.ts'
import type { ValidatedToolImage } from './tool-result-images.ts'

const TOOL_IMAGE_CACHE_TTL_MS = 60_000
const MAX_TOOL_IMAGE_CACHE_ENTRIES = 8
const MAX_TOOL_IMAGE_CACHE_BASE64_CHARS = 24 * 1024 * 1024

type ToolImageCacheEntry = {
  projectPath: string
  sessionKey: string
  sessionId: string
  runtime: RuntimeHost
  cachedAt: number
  base64Chars: number
  image: KernelMessageImage
}

export type ToolImageOwner = {
  projectPath: string
  sessionId: string
  sessionKey: string
  toolCallId: string
}

function cacheKey(owner: ToolImageOwner, contentIndex: number): string {
  return `${owner.projectPath}\0${owner.sessionId}\0${owner.sessionKey}\0${owner.toolCallId}\0${contentIndex}`
}

/**
 * Short-lived, bounded cache of completed tool-result images (moved from WorkbenchKernel, D-098).
 * The Kernel keeps every ownership decision; this class only stores, expires and bounds entries.
 */
export class ToolImageCache {
  private readonly entries = new Map<string, ToolImageCacheEntry>()
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
  }

  /** Cache the terminal images of one tool call for the Runtime that produced them. */
  store(owner: ToolImageOwner, runtime: RuntimeHost, images: readonly ValidatedToolImage[]): void {
    const cachedAt = this.now()
    this.prune(cachedAt)
    for (const image of images) {
      this.entries.set(cacheKey(owner, image.contentIndex), {
        projectPath: owner.projectPath,
        sessionKey: owner.sessionKey,
        sessionId: owner.sessionId,
        runtime,
        cachedAt,
        base64Chars: image.data.length,
        image: {
          mimeType: image.mimeType,
          data: image.data,
          name: image.name.length > 0 ? image.name : `image-${image.contentIndex + 1}`,
          path: ''
        }
      })
    }
    this.prune(cachedAt)
  }

  /** A copy of a live entry from the same Runtime, or null when missing or expired. */
  read(owner: ToolImageOwner, contentIndex: number, runtime: RuntimeHost, now: number): KernelMessageImage | null {
    const cached = this.entries.get(cacheKey(owner, contentIndex))
    if (cached === undefined || cached.runtime !== runtime || cached.cachedAt + TOOL_IMAGE_CACHE_TTL_MS <= now) return null
    return { ...cached.image }
  }

  delete(owner: ToolImageOwner, contentIndex: number): void {
    this.entries.delete(cacheKey(owner, contentIndex))
  }

  clearForSession(sessionKey: string): void {
    for (const [key, cached] of this.entries) {
      if (cached.sessionKey === sessionKey) this.entries.delete(key)
    }
  }

  clearForTool(owner: ToolImageOwner): void {
    const prefix = `${owner.projectPath}\0${owner.sessionId}\0${owner.sessionKey}\0${owner.toolCallId}\0`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  prune(now = this.now()): void {
    for (const [key, cached] of this.entries) {
      if (cached.cachedAt + TOOL_IMAGE_CACHE_TTL_MS <= now) this.entries.delete(key)
    }
    let totalBase64Chars = 0
    for (const cached of this.entries.values()) totalBase64Chars += cached.base64Chars
    for (const [key, cached] of this.entries) {
      if (
        this.entries.size <= MAX_TOOL_IMAGE_CACHE_ENTRIES &&
        totalBase64Chars <= MAX_TOOL_IMAGE_CACHE_BASE64_CHARS
      ) break
      this.entries.delete(key)
      totalBase64Chars -= cached.base64Chars
    }
  }
}
