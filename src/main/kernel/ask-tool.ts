import type {
  KernelAskAnswer,
  KernelAskOption,
  KernelAskQuestion
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent } from '../pi-rpc/pi-rpc-client.ts'
import { isRecord } from '../utils/guards.ts'

const MAX_QUESTIONS = 8
const MAX_OPTIONS = 12
const MAX_ID_CHARS = 64
const MAX_PROMPT_CHARS = 1_000
const MAX_OPTION_VALUE_CHARS = 128
const MAX_OPTION_LABEL_CHARS = 200
const MAX_OPTION_DESCRIPTION_CHARS = 500
const MAX_PLACEHOLDER_CHARS = 200
const MAX_TEXT_ANSWER_CHARS = 4_000
const MAX_RPC_REQUEST_ID_CHARS = 256
const ASK_TITLE_PREFIX = 'Ask · '
export const ASK_MULTIPLE_DONE_LABEL = '✓ Done'
export const ASK_CUSTOM_OPTION_LABEL = '其他（自行输入）'
export const ASK_CUSTOM_INPUT_PLACEHOLDER = '请输入你的回答'

export type AskUiRequest =
  | {
      id: string
      method: 'select'
      title: string
      options: string[]
    }
  | {
      id: string
      method: 'input'
      title: string
      placeholder: string | null
    }

type AskUiExpectation =
  | {
      method: 'select'
      title: string
      options: string[]
    }
  | {
      method: 'input'
      title: string
      placeholder: string | null
    }

export type AskResponseStep = {
  questionId: string
  request: AskUiExpectation
  value: string
}

export function isAskToolName(name: string): boolean {
  return name.trim().toLowerCase().split(/[.:/]/u).at(-1) === 'ask'
}

export function projectAskQuestions(value: unknown): KernelAskQuestion[] | null {
  const args = parseRecordValue(value)
  if (
    args === null ||
    !Array.isArray(args.questions) ||
    args.questions.length === 0 ||
    args.questions.length > MAX_QUESTIONS
  ) return null

  const questions: KernelAskQuestion[] = []
  const ids = new Set<string>()
  for (const value of args.questions) {
    const question = projectQuestion(value)
    if (question === null || ids.has(question.id)) return null
    ids.add(question.id)
    questions.push(question)
  }
  return questions
}

export function normalizeAskUiRequest(event: PiRpcEvent): AskUiRequest | null {
  if (
    event.type !== 'extension_ui_request' ||
    !isBoundedString(event.id, MAX_RPC_REQUEST_ID_CHARS) ||
    !isBoundedString(event.title, MAX_PROMPT_CHARS + ASK_TITLE_PREFIX.length)
  ) return null

  if (event.method === 'select') {
    if (
      !Array.isArray(event.options) ||
      event.options.length === 0 ||
      event.options.length > MAX_OPTIONS + 2 ||
      !event.options.every((option) => isBoundedString(option, MAX_OPTION_LABEL_CHARS))
    ) return null
    return {
      id: event.id,
      method: 'select',
      title: event.title,
      options: [...event.options]
    }
  }

  if (event.method === 'input') {
    if (
      event.placeholder !== undefined &&
      !isBoundedString(event.placeholder, MAX_PLACEHOLDER_CHARS, true)
    ) return null
    return {
      id: event.id,
      method: 'input',
      title: event.title,
      placeholder: typeof event.placeholder === 'string' ? event.placeholder : null
    }
  }

  return null
}

export function createInitialAskResponseStep(
  question: KernelAskQuestion
): AskResponseStep {
  const request = requestForQuestion(question)
  return {
    questionId: question.id,
    request,
    value: question.type === 'text'
      ? ''
      : question.type === 'multiple'
        ? ASK_MULTIPLE_DONE_LABEL
        : question.options[0]?.label ?? ''
  }
}

export function createAskResponsePlan(
  questions: readonly KernelAskQuestion[],
  answers: readonly KernelAskAnswer[]
): AskResponseStep[] {
  const canonical = canonicalAskAnswers(questions, answers)
  const steps: AskResponseStep[] = []
  for (const question of questions) {
    const answer = canonical.get(question.id)
    if (answer === undefined) throw new Error(`Missing answer for ask question: ${question.id}`)
    if (question.type === 'text') {
      steps.push({
        questionId: question.id,
        request: requestForQuestion(question),
        value: answer.value as string
      })
      continue
    }
    if (question.type === 'single') {
      if (answer.customValue !== null) {
        steps.push({
          questionId: question.id,
          request: selectRequest(question, question.options, true),
          value: ASK_CUSTOM_OPTION_LABEL
        }, {
          questionId: question.id,
          request: customInputRequest(question),
          value: answer.customValue
        })
        continue
      }
      const option = optionForValue(question, answer.value as string)
      steps.push({
        questionId: question.id,
        request: requestForQuestion(question),
        value: option.label
      })
      continue
    }

    const selectedValues = answer.value as string[]
    const remaining = [...question.options]
    for (const selectedValue of selectedValues) {
      const optionIndex = remaining.findIndex((option) => option.value === selectedValue)
      const option = remaining[optionIndex]
      if (option === undefined) throw new Error(`Invalid answer for ask question: ${question.id}`)
      steps.push({
        questionId: question.id,
        request: selectRequest(question, remaining, true),
        value: option.label
      })
      remaining.splice(optionIndex, 1)
    }
    if (answer.customValue !== null) {
      steps.push({
        questionId: question.id,
        request: selectRequest(question, remaining, true),
        value: ASK_CUSTOM_OPTION_LABEL
      }, {
        questionId: question.id,
        request: customInputRequest(question),
        value: answer.customValue
      })
    }
    steps.push({
      questionId: question.id,
      request: selectRequest(question, remaining, answer.customValue === null),
      value: ASK_MULTIPLE_DONE_LABEL
    })
  }
  return steps
}

export function askUiRequestMatchesStep(
  request: AskUiRequest,
  step: AskResponseStep
): boolean {
  if (request.method !== step.request.method || request.title !== step.request.title) return false
  if (request.method === 'input' && step.request.method === 'input') {
    return request.placeholder === step.request.placeholder
  }
  if (request.method === 'select' && step.request.method === 'select') {
    const expectedOptions = step.request.options
    return request.options.length === expectedOptions.length &&
      request.options.every((option, index) => option === expectedOptions[index])
  }
  return false
}

type CanonicalAskAnswer = {
  value: string | string[]
  customValue: string | null
}

function canonicalAskAnswers(
  questions: readonly KernelAskQuestion[],
  answers: readonly KernelAskAnswer[]
): Map<string, CanonicalAskAnswer> {
  if (answers.length !== questions.length) {
    throw new Error('Ask answers must include every question exactly once.')
  }
  const byId = new Map<string, KernelAskAnswer>()
  for (const answer of answers) {
    if (byId.has(answer.questionId)) throw new Error(`Duplicate ask answer: ${answer.questionId}`)
    byId.set(answer.questionId, answer)
  }

  const canonical = new Map<string, CanonicalAskAnswer>()
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) throw new Error(`Missing answer for ask question: ${question.id}`)
    const customValue = answer.customValue === undefined
      ? null
      : canonicalCustomAnswer(question.id, answer.customValue)
    if (question.type === 'text') {
      if (customValue !== null || typeof answer.value !== 'string') {
        throw new Error(`Ask question ${question.id} requires a text answer.`)
      }
      const value = answer.value.trim()
      if (value.length === 0 || value.length > MAX_TEXT_ANSWER_CHARS || value.includes('\0')) {
        throw new Error(`Invalid text answer for ask question: ${question.id}`)
      }
      canonical.set(question.id, { value, customValue: null })
      continue
    }
    if (question.type === 'single') {
      if (typeof answer.value !== 'string') {
        throw new Error(`Ask question ${question.id} requires one option.`)
      }
      if (customValue !== null) {
        if (answer.value.length !== 0) {
          throw new Error(`Custom ask answer ${question.id} must not include a fixed option.`)
        }
        canonical.set(question.id, { value: '', customValue })
        continue
      }
      optionForValue(question, answer.value)
      canonical.set(question.id, { value: answer.value, customValue: null })
      continue
    }
    if (!Array.isArray(answer.value) || (answer.value.length === 0 && customValue === null)) {
      throw new Error(`Ask question ${question.id} requires one or more options.`)
    }
    if (new Set(answer.value).size !== answer.value.length) {
      throw new Error(`Ask question ${question.id} contains duplicate options.`)
    }
    const selected = new Set(answer.value)
    for (const value of selected) optionForValue(question, value)
    canonical.set(question.id, {
      value: question.options
        .filter((option) => selected.has(option.value))
        .map((option) => option.value),
      customValue
    })
  }
  return canonical
}

function canonicalCustomAnswer(questionId: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_ANSWER_CHARS || trimmed.includes('\0')) {
    throw new Error(`Invalid custom answer for ask question: ${questionId}`)
  }
  return trimmed
}

function projectQuestion(value: unknown): KernelAskQuestion | null {
  if (!isRecord(value)) return null
  if (
    !isQuestionId(value.id) ||
    !isBoundedString(value.prompt, MAX_PROMPT_CHARS) ||
    (value.type !== 'single' && value.type !== 'multiple' && value.type !== 'text')
  ) return null

  if (value.type === 'text') {
    if (
      value.options !== undefined &&
      (!Array.isArray(value.options) || value.options.length !== 0)
    ) return null
    if (
      value.placeholder !== undefined &&
      !isBoundedString(value.placeholder, MAX_PLACEHOLDER_CHARS, true)
    ) return null
    return {
      id: value.id,
      prompt: value.prompt.trim(),
      type: 'text',
      options: [],
      placeholder: typeof value.placeholder === 'string' ? value.placeholder : null
    }
  }

  if (
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.length > MAX_OPTIONS ||
    value.placeholder !== undefined
  ) return null
  const options: KernelAskOption[] = []
  const optionValues = new Set<string>()
  const optionLabels = new Set<string>()
  for (const optionValue of value.options) {
    const option = projectOption(optionValue)
    if (
      option === null ||
      option.label === ASK_MULTIPLE_DONE_LABEL ||
      option.label === ASK_CUSTOM_OPTION_LABEL ||
      optionValues.has(option.value) ||
      optionLabels.has(option.label)
    ) return null
    optionValues.add(option.value)
    optionLabels.add(option.label)
    options.push(option)
  }
  return {
    id: value.id,
    prompt: value.prompt.trim(),
    type: value.type,
    options,
    placeholder: null
  }
}

function projectOption(value: unknown): KernelAskOption | null {
  if (
    !isRecord(value) ||
    !isBoundedString(value.value, MAX_OPTION_VALUE_CHARS) ||
    !isBoundedString(value.label, MAX_OPTION_LABEL_CHARS) ||
    (
      value.description !== undefined &&
      !isBoundedString(value.description, MAX_OPTION_DESCRIPTION_CHARS, true)
    )
  ) return null
  return {
    value: value.value,
    label: value.label.trim(),
    description: typeof value.description === 'string' && value.description.trim().length > 0
      ? value.description.trim()
      : null
  }
}

function requestForQuestion(question: KernelAskQuestion): AskUiExpectation {
  if (question.type === 'text') {
    return {
      method: 'input',
      title: askTitle(question),
      placeholder: question.placeholder
    }
  }
  return selectRequest(question, question.options, true)
}

function selectRequest(
  question: KernelAskQuestion,
  options: readonly KernelAskOption[],
  includeCustom: boolean
): Extract<AskUiExpectation, { method: 'select' }> {
  return {
    method: 'select',
    title: askTitle(question),
    options: [
      ...options.map((option) => option.label),
      ...(includeCustom ? [ASK_CUSTOM_OPTION_LABEL] : []),
      ...(question.type === 'multiple' ? [ASK_MULTIPLE_DONE_LABEL] : [])
    ]
  }
}

function customInputRequest(
  question: KernelAskQuestion
): Extract<AskUiExpectation, { method: 'input' }> {
  return {
    method: 'input',
    title: `${askTitle(question)} · 其他`,
    placeholder: ASK_CUSTOM_INPUT_PLACEHOLDER
  }
}

function askTitle(question: KernelAskQuestion): string {
  return `${ASK_TITLE_PREFIX}${question.prompt}`
}

function optionForValue(question: KernelAskQuestion, value: string): KernelAskOption {
  const option = question.options.find((option) => option.value === value)
  if (option === undefined) throw new Error(`Invalid answer for ask question: ${question.id}`)
  return option
}

function parseRecordValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isQuestionId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_CHARS &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
}

function isBoundedString(value: unknown, maxChars: number, allowEmpty = false): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maxChars &&
    !value.includes('\0')
}
