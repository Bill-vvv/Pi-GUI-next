export const HISTORY_NAVIGATION_COMMAND_NAME: 'pi-gui-history-navigation'
export const HISTORY_NAVIGATION_COMMAND_DESCRIPTION:
  'Internal Pi GUI history prompt navigation. Not a user command.'
export const MAX_HISTORY_NAVIGATION_ENTRY_ID_LENGTH: 512

export function parseHistoryNavigationCommandArgs(args: unknown): string | null
export function buildHistoryNavigationCommandArgs(targetEntryId: unknown): string
export function isInternalHistoryNavigationCommandName(name: unknown): boolean
