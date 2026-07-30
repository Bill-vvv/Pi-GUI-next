import {
  OPENAI_FAST_MODE_COMMAND_NAME,
  OPENAI_FAST_MODE_ENTRY_TYPE,
  buildOpenAiFastModeCommandArgs,
  isInternalOpenAiFastModeCommandName,
  parseOpenAiFastModeEntryData
} from '../../../extensions/pi-gui-openai-fast-mode/src/protocol.mjs'
import type { PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'

export {
  OPENAI_FAST_MODE_COMMAND_NAME,
  OPENAI_FAST_MODE_ENTRY_TYPE,
  buildOpenAiFastModeCommandArgs,
  isInternalOpenAiFastModeCommandName
}

export function openAiFastModeFromSessionEntries(
  activePath: readonly PiRpcSessionEntry[]
): boolean {
  for (let index = activePath.length - 1; index >= 0; index -= 1) {
    const entry = activePath[index]
    if (entry?.type !== 'custom' || entry.customType !== OPENAI_FAST_MODE_ENTRY_TYPE) continue
    return parseOpenAiFastModeEntryData(entry.data) ?? false
  }
  return false
}
