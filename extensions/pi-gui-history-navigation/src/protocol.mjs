/** Shared internal command protocol for Pi GUI history navigation. */

export const HISTORY_NAVIGATION_COMMAND_NAME = 'pi-gui-history-navigation'
export const HISTORY_NAVIGATION_COMMAND_DESCRIPTION =
  'Internal Pi GUI history prompt navigation. Not a user command.'
export const MAX_HISTORY_NAVIGATION_ENTRY_ID_LENGTH = 512

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u

export function parseHistoryNavigationCommandArgs(args) {
  if (typeof args !== 'string') return null
  if (
    args.length === 0 ||
    args.length > MAX_HISTORY_NAVIGATION_ENTRY_ID_LENGTH ||
    args.trim() !== args ||
    CONTROL_CHARACTER_PATTERN.test(args)
  ) return null
  return args
}

export function buildHistoryNavigationCommandArgs(targetEntryId) {
  const parsed = parseHistoryNavigationCommandArgs(targetEntryId)
  if (parsed === null) throw new Error('History navigation target entry ID is malformed.')
  return parsed
}

export function isInternalHistoryNavigationCommandName(name) {
  return name === HISTORY_NAVIGATION_COMMAND_NAME
}
