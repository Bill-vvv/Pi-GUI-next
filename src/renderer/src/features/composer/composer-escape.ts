export type ComposerEscapeAbortInput = {
  enabled: boolean
  running: boolean
  key: string
  defaultPrevented: boolean
  isComposing: boolean
  keyCode: number
}

export function shouldAbortComposerFromEscape({
  enabled,
  running,
  key,
  defaultPrevented,
  isComposing,
  keyCode
}: ComposerEscapeAbortInput): boolean {
  return enabled &&
    running &&
    key === 'Escape' &&
    !defaultPrevented &&
    !isComposing &&
    keyCode !== 229
}
