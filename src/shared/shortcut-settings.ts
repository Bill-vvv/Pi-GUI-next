export const SHORTCUT_ACTION_IDS = [
  'new-session',
  'focus-composer',
  'open-settings',
  'open-model-selector',
  'reload-session',
  'previous-project',
  'next-project',
  'previous-session',
  'next-session',
  'archive-session',
  'copy-last-answer'
] as const

export type ShortcutActionId = typeof SHORTCUT_ACTION_IDS[number]
export type ShortcutBinding = string | null
export type ShortcutSettings = Record<ShortcutActionId, ShortcutBinding>

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
  'new-session': 'Ctrl+N',
  'focus-composer': 'Ctrl+L',
  'open-settings': 'Ctrl+,',
  'open-model-selector': null,
  'reload-session': null,
  'previous-project': null,
  'next-project': null,
  'previous-session': 'Ctrl+PageUp',
  'next-session': 'Ctrl+PageDown',
  'archive-session': null,
  'copy-last-answer': null
}

const SYSTEM_RESERVED_BINDINGS = new Set([
  'F11',
  'F12',
  'Alt+F4',
  'Ctrl+0',
  'Ctrl+-',
  'Ctrl+=',
  'Ctrl+Shift+=',
  'Ctrl+F',
  'Ctrl+P',
  'Ctrl+Q',
  'Ctrl+R',
  'Ctrl+S',
  'Ctrl+U',
  'Ctrl+W',
  'Ctrl+Shift+I',
  'Ctrl+Shift+R',
  'Ctrl+Shift+W'
])

const EDITING_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'Insert',
  'Tab'
])

const EDITING_BINDINGS = new Set([
  'Ctrl+A',
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+X',
  'Ctrl+Y',
  'Ctrl+Z',
  'Ctrl+Shift+Z'
])

const PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/'
}

export type ShortcutKeyboardInput = {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  isComposing?: boolean
}

export type ShortcutSettingsIssue =
  | { type: 'invalid-shape' }
  | { type: 'invalid-binding'; actionId: ShortcutActionId; binding: string }
  | { type: 'reserved-binding'; actionId: ShortcutActionId; binding: string }
  | {
      type: 'duplicate-binding'
      actionId: ShortcutActionId
      conflictingActionId: ShortcutActionId
      binding: string
    }

export function copyShortcutSettings(settings: ShortcutSettings): ShortcutSettings {
  return Object.fromEntries(
    SHORTCUT_ACTION_IDS.map((actionId) => [actionId, settings[actionId]])
  ) as ShortcutSettings
}

export function shortcutBindingFromKeyboardInput(
  input: ShortcutKeyboardInput
): string | null {
  if (input.isComposing || input.metaKey) return null

  const key = normalizeKeyboardKey(input)
  if (key === null || EDITING_KEYS.has(key)) return null

  const modifiers = [
    input.ctrlKey ? 'Ctrl' : null,
    input.altKey ? 'Alt' : null,
    input.shiftKey ? 'Shift' : null
  ].filter((modifier): modifier is string => modifier !== null)

  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(key)
  if (!isFunctionKey && !input.ctrlKey && !input.altKey) return null

  return [...modifiers, key].join('+')
}

export function findShortcutSettingsIssue(value: unknown): ShortcutSettingsIssue | null {
  if (!isRecord(value) || Object.keys(value).length !== SHORTCUT_ACTION_IDS.length) {
    return { type: 'invalid-shape' }
  }

  const usedBindings = new Map<string, ShortcutActionId>()
  for (const actionId of SHORTCUT_ACTION_IDS) {
    const binding = value[actionId]
    if (binding === null) continue
    if (typeof binding !== 'string' || !isCanonicalBinding(binding)) {
      return {
        type: 'invalid-binding',
        actionId,
        binding: typeof binding === 'string' ? binding : ''
      }
    }
    if (SYSTEM_RESERVED_BINDINGS.has(binding) || EDITING_BINDINGS.has(binding)) {
      return { type: 'reserved-binding', actionId, binding }
    }
    const conflictingActionId = usedBindings.get(binding)
    if (conflictingActionId !== undefined) {
      return { type: 'duplicate-binding', actionId, conflictingActionId, binding }
    }
    usedBindings.set(binding, actionId)
  }
  return null
}

export function isShortcutSettings(value: unknown): value is ShortcutSettings {
  return findShortcutSettingsIssue(value) === null
}

function normalizeKeyboardKey(input: ShortcutKeyboardInput): string | null {
  const code = input.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const punctuation = PUNCTUATION_BY_CODE[code]
  if (punctuation !== undefined) return punctuation

  if (/^[a-z]$/i.test(input.key)) return input.key.toUpperCase()
  if (/^[0-9]$/.test(input.key)) return input.key
  if (/^F(?:[1-9]|1[0-2])$/.test(input.key)) return input.key
  if (
    input.key === 'PageUp' ||
    input.key === 'PageDown' ||
    input.key === 'ArrowUp' ||
    input.key === 'ArrowDown' ||
    input.key === 'ArrowLeft' ||
    input.key === 'ArrowRight' ||
    input.key === 'Home' ||
    input.key === 'End' ||
    input.key === 'Insert' ||
    input.key === 'Delete' ||
    input.key === 'Backspace' ||
    input.key === 'Enter' ||
    input.key === 'Escape' ||
    input.key === 'Tab'
  ) {
    return input.key
  }
  if (input.key === ' ') return 'Space'
  if (Object.values(PUNCTUATION_BY_CODE).includes(input.key)) return input.key
  return null
}

function isCanonicalBinding(binding: string): boolean {
  const parts = binding.split('+')
  if (parts.some((part) => part.length === 0)) return false

  const key = parts.at(-1)
  if (key === undefined || EDITING_KEYS.has(key)) return false
  const modifiers = parts.slice(0, -1)
  if (
    modifiers.some((modifier) => modifier !== 'Ctrl' && modifier !== 'Alt' && modifier !== 'Shift') ||
    new Set(modifiers).size !== modifiers.length ||
    modifiers.join('+') !== ['Ctrl', 'Alt', 'Shift'].filter((modifier) => modifiers.includes(modifier)).join('+')
  ) {
    return false
  }

  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/.test(key)
  const isNamedKey = key === 'PageUp' || key === 'PageDown' || key === 'Space'
  const isPrintableKey = /^[A-Z0-9]$/.test(key) || Object.values(PUNCTUATION_BY_CODE).includes(key)
  if (!isFunctionKey && !isNamedKey && !isPrintableKey) return false
  if (!isFunctionKey && !modifiers.includes('Ctrl') && !modifiers.includes('Alt')) return false
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
