import type { KernelExtensionDialogRequest } from '../../shared/kernel-contract.ts'
import type { PiRpcEvent } from '../pi-rpc/pi-rpc-client.ts'

const MAX_REQUEST_ID_CHARS = 256
const MAX_COMMAND_NAME_CHARS = 256
const MAX_TITLE_CHARS = 1_000
const MAX_MESSAGE_CHARS = 8_000
const MAX_OPTIONS = 64
const MAX_OPTION_CHARS = 500
const MAX_PLACEHOLDER_CHARS = 500
const MAX_PREFILL_CHARS = 16_000
export const MAX_EXTENSION_DIALOG_RESPONSE_CHARS = 16_000

export type NormalizedExtensionDialogRequest = Pick<
  KernelExtensionDialogRequest,
  'requestId' | 'commandInvocationId' | 'commandName' | 'method' | 'title' | 'message' | 'options' | 'placeholder' | 'prefill'
>

export function normalizeExtensionDialogRequest(
  event: PiRpcEvent
): NormalizedExtensionDialogRequest | null {
  if (
    event.type !== 'extension_ui_request' ||
    !isBoundedString(event.id, MAX_REQUEST_ID_CHARS) ||
    !isBoundedString(event.commandInvocationId, MAX_REQUEST_ID_CHARS) ||
    !isBoundedString(event.commandName, MAX_COMMAND_NAME_CHARS) ||
    !isBoundedString(event.title, MAX_TITLE_CHARS, true)
  ) return null

  const common = {
    requestId: event.id,
    commandInvocationId: event.commandInvocationId,
    commandName: event.commandName,
    title: event.title
  }

  if (event.method === 'select') {
    if (
      !Array.isArray(event.options) ||
      event.options.length === 0 ||
      event.options.length > MAX_OPTIONS ||
      !event.options.every((option) => isBoundedString(option, MAX_OPTION_CHARS)) ||
      new Set(event.options).size !== event.options.length
    ) return null
    return {
      ...common,
      method: 'select',
      message: null,
      options: [...event.options],
      placeholder: null,
      prefill: null
    }
  }

  if (event.method === 'confirm') {
    if (!isBoundedString(event.message, MAX_MESSAGE_CHARS, true)) return null
    return {
      ...common,
      method: 'confirm',
      message: event.message,
      options: [],
      placeholder: null,
      prefill: null
    }
  }

  if (event.method === 'input') {
    if (
      event.placeholder !== undefined &&
      !isBoundedString(event.placeholder, MAX_PLACEHOLDER_CHARS, true)
    ) return null
    return {
      ...common,
      method: 'input',
      message: null,
      options: [],
      placeholder: typeof event.placeholder === 'string' ? event.placeholder : null,
      prefill: null
    }
  }

  if (event.method === 'editor') {
    if (
      event.prefill !== undefined &&
      !isBoundedString(event.prefill, MAX_PREFILL_CHARS, true)
    ) return null
    return {
      ...common,
      method: 'editor',
      message: null,
      options: [],
      placeholder: null,
      prefill: typeof event.prefill === 'string' ? event.prefill : null
    }
  }

  return null
}

export function assertExtensionDialogResponse(
  request: Pick<KernelExtensionDialogRequest, 'method' | 'options'>,
  value: string
): void {
  if (value.length > MAX_EXTENSION_DIALOG_RESPONSE_CHARS || value.includes('\0')) {
    throw new Error('Extension dialog response is malformed.')
  }
  if (request.method === 'select' && !request.options.includes(value)) {
    throw new Error('Extension dialog selection is not one of the offered options.')
  }
  if (request.method === 'confirm' && value !== 'true' && value !== 'false') {
    throw new Error('Extension confirmation response must be true or false.')
  }
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === 'string' &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    !value.includes('\0')
}
