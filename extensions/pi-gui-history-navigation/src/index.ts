import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import {
  HISTORY_NAVIGATION_COMMAND_DESCRIPTION,
  HISTORY_NAVIGATION_COMMAND_NAME,
  parseHistoryNavigationCommandArgs
} from './protocol.mjs'

const ROOT_NAVIGATION_PIVOT_CUSTOM_TYPE = 'pi-gui.history-navigation-pivot/v1'

export async function navigateToHistoryPrompt(
  targetEntryId: string,
  ctx: ExtensionCommandContext,
  appendRootNavigationPivot: () => void
): Promise<void> {
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    throw new Error('History navigation requires an idle Pi Session.')
  }

  const target = ctx.sessionManager.getEntry(targetEntryId)
  if (target?.type !== 'message' || target.message.role !== 'user') {
    throw new Error('History navigation target must be a user message.')
  }

  if (ctx.sessionManager.getLeafId() === targetEntryId) {
    if (target.parentId === null) {
      appendRootNavigationPivot()
    } else {
      const repositioned = await ctx.navigateTree(target.parentId)
      if (repositioned.cancelled) throw new Error('History navigation was cancelled.')
    }
  }

  const result = await ctx.navigateTree(targetEntryId)
  if (result.cancelled) throw new Error('History navigation was cancelled.')
  if (ctx.sessionManager.getLeafId() !== target.parentId) {
    throw new Error('History navigation did not select the prompt parent.')
  }
}

export default function historyNavigationExtension(pi: ExtensionAPI): void {
  pi.registerCommand(HISTORY_NAVIGATION_COMMAND_NAME, {
    description: HISTORY_NAVIGATION_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      const targetEntryId = parseHistoryNavigationCommandArgs(args)
      if (targetEntryId === null) {
        throw new Error('History navigation target entry ID is malformed.')
      }
      await navigateToHistoryPrompt(
        targetEntryId,
        ctx,
        () => pi.appendEntry(ROOT_NAVIGATION_PIVOT_CUSTOM_TYPE)
      )
    }
  })
}
