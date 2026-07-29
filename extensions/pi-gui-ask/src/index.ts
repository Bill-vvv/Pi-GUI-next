import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import {
  createOperationLeaseController,
  installOperationLeaseProvider
} from './quiescence-provider.mjs'

const MAX_QUESTIONS = 8
const MAX_OPTIONS = 12
const MAX_TEXT_ANSWER_CHARS = 4_000
const ASK_MULTIPLE_DONE_LABEL = '✓ Done'
const ASK_CUSTOM_OPTION_LABEL = '其他（自行输入）'
const ASK_CUSTOM_INPUT_PLACEHOLDER = '请输入你的回答'
const ASK_TITLE_PREFIX = 'Ask · '

type AskOption = {
  value: string
  label: string
  description?: string
}

type AskQuestion = {
  id: string
  prompt: string
  type: 'single' | 'multiple' | 'text'
  options: AskOption[]
  placeholder?: string
}

type AskAnswer = {
  questionId: string
  value: string | string[]
  label: string | string[]
}

type AskDetails = {
  version: 1
  cancelled: boolean
  questions: AskQuestion[]
  answers: AskAnswer[]
}

const AskOptionSchema = Type.Object({
  value: Type.String({
    minLength: 1,
    maxLength: 128,
    description: 'Stable value returned to the Agent'
  }),
  label: Type.String({
    minLength: 1,
    maxLength: 200,
    description: 'User-visible option label'
  }),
  description: Type.Optional(Type.String({
    maxLength: 500,
    description: 'Optional secondary explanation shown below the label'
  }))
})

const AskQuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
    description: 'Unique answer key'
  }),
  prompt: Type.String({
    minLength: 1,
    maxLength: 1_000,
    description: 'Question shown to the user'
  }),
  type: StringEnum(['single', 'multiple', 'text'] as const),
  options: Type.Optional(Type.Array(AskOptionSchema, {
    minItems: 2,
    maxItems: MAX_OPTIONS,
    description: 'Required for single and multiple questions; omit for text'
  })),
  placeholder: Type.Optional(Type.String({
    maxLength: 200,
    description: 'Optional placeholder for text questions'
  }))
})

const AskParams = Type.Object({
  questions: Type.Array(AskQuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: 'Independent questions to answer together in one interaction'
  })
})

export default function askExtension(pi: ExtensionAPI) {
  const operationLease = createOperationLeaseController()
  installOperationLeaseProvider(pi.events, 'pi-gui-ask', operationLease)
  pi.on('session_start', () => {
    operationLease.startSession()
  })
  pi.on('session_shutdown', () => {
    operationLease.endSession()
  })

  pi.registerTool({
    name: 'ask',
    label: 'Ask',
    description:
      'Ask the user one or more structured questions in a single tool call. Supports single-choice, multiple-choice, custom user-written choice answers, and required free-text answers. Use this to batch independent clarification questions instead of asking them across several conversation turns.',
    promptSnippet: 'Ask the user several structured questions in one interaction',
    promptGuidelines: [
      'Use ask when two or more independent user decisions are required before continuing; group them into one call.',
      'Do not use ask for information that can be discovered from the project or inferred safely.',
      'Keep ask choices concrete and mutually understandable, and use text questions only when fixed options are insufficient.'
    ],
    parameters: AskParams,
    executionMode: 'sequential',

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error('The ask tool requires an interactive UI.')
      const finish = operationLease.beginOperation()
      if (finish === null) {
        throw new Error('The ask tool is unavailable while this Runtime is hibernating.')
      }
      try {
      const questions = normalizeQuestions(params.questions)
      const answers: AskAnswer[] = []

      for (const question of questions) {
        const title = `${ASK_TITLE_PREFIX}${question.prompt}`
        if (question.type === 'text') {
          while (true) {
            const value = await ctx.ui.input(title, question.placeholder, { signal })
            if (value === undefined) return cancelledResult(questions)
            const trimmed = value.trim()
            if (trimmed.length === 0) {
              ctx.ui.notify('A response is required.', 'warning')
              continue
            }
            if (trimmed.length > MAX_TEXT_ANSWER_CHARS || trimmed.includes('\0')) {
              throw new Error(`Invalid answer for ${question.id}.`)
            }
            answers.push({ questionId: question.id, value: trimmed, label: trimmed })
            break
          }
          continue
        }

        if (question.type === 'single') {
          const selectedLabel = await ctx.ui.select(
            title,
            [...question.options.map((option) => option.label), ASK_CUSTOM_OPTION_LABEL],
            { signal }
          )
          if (selectedLabel === undefined) return cancelledResult(questions)
          if (selectedLabel === ASK_CUSTOM_OPTION_LABEL) {
            const customTitle = `${title} · 其他`
            while (true) {
              const value = await ctx.ui.input(customTitle, ASK_CUSTOM_INPUT_PLACEHOLDER, { signal })
              if (value === undefined) return cancelledResult(questions)
              const trimmed = value.trim()
              if (trimmed.length === 0) {
                ctx.ui.notify('A response is required.', 'warning')
                continue
              }
              if (trimmed.length > MAX_TEXT_ANSWER_CHARS || trimmed.includes('\0')) {
                throw new Error(`Invalid answer for ${question.id}.`)
              }
              answers.push({ questionId: question.id, value: trimmed, label: trimmed })
              break
            }
            continue
          }
          const option = question.options.find((option) => option.label === selectedLabel)
          if (option === undefined) throw new Error(`Invalid selection for ${question.id}.`)
          answers.push({ questionId: question.id, value: option.value, label: option.label })
          continue
        }

        const remaining = [...question.options]
        const selected: AskOption[] = []
        let customAnswer: string | null = null
        while (true) {
          const selectedLabel = await ctx.ui.select(
            title,
            [
              ...remaining.map((option) => option.label),
              ...(customAnswer === null ? [ASK_CUSTOM_OPTION_LABEL] : []),
              ASK_MULTIPLE_DONE_LABEL
            ],
            { signal }
          )
          if (selectedLabel === undefined) return cancelledResult(questions)
          if (selectedLabel === ASK_MULTIPLE_DONE_LABEL) {
            if (selected.length === 0 && customAnswer === null) {
              ctx.ui.notify('Select at least one option.', 'warning')
              continue
            }
            break
          }
          if (selectedLabel === ASK_CUSTOM_OPTION_LABEL) {
            const customTitle = `${title} · 其他`
            while (true) {
              const value = await ctx.ui.input(customTitle, ASK_CUSTOM_INPUT_PLACEHOLDER, { signal })
              if (value === undefined) return cancelledResult(questions)
              const trimmed = value.trim()
              if (trimmed.length === 0) {
                ctx.ui.notify('A response is required.', 'warning')
                continue
              }
              if (trimmed.length > MAX_TEXT_ANSWER_CHARS || trimmed.includes('\0')) {
                throw new Error(`Invalid answer for ${question.id}.`)
              }
              customAnswer = trimmed
              break
            }
            continue
          }
          const optionIndex = remaining.findIndex((option) => option.label === selectedLabel)
          const option = remaining[optionIndex]
          if (option === undefined) throw new Error(`Invalid selection for ${question.id}.`)
          selected.push(option)
          remaining.splice(optionIndex, 1)
        }
        answers.push({
          questionId: question.id,
          value: [
            ...selected.map((option) => option.value),
            ...(customAnswer === null ? [] : [customAnswer])
          ],
          label: [
            ...selected.map((option) => option.label),
            ...(customAnswer === null ? [] : [customAnswer])
          ]
        })
      }

      const details: AskDetails = {
        version: 1,
        cancelled: false,
        questions,
        answers
      }
      return {
        content: [{ type: 'text' as const, text: formatAnswers(answers) }],
        details
      }
      } finally {
        finish()
      }
    }
  })
}

function normalizeQuestions(value: unknown): AskQuestion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    throw new Error(`ask requires 1-${MAX_QUESTIONS} questions.`)
  }
  const ids = new Set<string>()
  return value.map((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Invalid ask question.')
    }
    const input = candidate as Record<string, unknown>
    if (
      !isBoundedString(input.id, 64) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(input.id) ||
      ids.has(input.id) ||
      !isBoundedString(input.prompt, 1_000) ||
      (input.type !== 'single' && input.type !== 'multiple' && input.type !== 'text')
    ) {
      throw new Error('Invalid or duplicate ask question.')
    }
    ids.add(input.id)

    if (input.type === 'text') {
      if (input.options !== undefined && (!Array.isArray(input.options) || input.options.length > 0)) {
        throw new Error(`Text question ${input.id} must not define options.`)
      }
      if (input.placeholder !== undefined && !isBoundedString(input.placeholder, 200, true)) {
        throw new Error(`Invalid placeholder for ${input.id}.`)
      }
      return {
        id: input.id,
        prompt: input.prompt.trim(),
        type: 'text',
        options: [],
        ...(typeof input.placeholder === 'string' ? { placeholder: input.placeholder } : {})
      }
    }

    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > MAX_OPTIONS) {
      throw new Error(`Choice question ${input.id} requires 2-${MAX_OPTIONS} options.`)
    }
    if (input.placeholder !== undefined) {
      throw new Error(`Choice question ${input.id} must not define a placeholder.`)
    }
    const options = input.options.map(normalizeOption)
    const values = new Set(options.map((option) => option.value))
    const labels = new Set(options.map((option) => option.label))
    if (
      values.size !== options.length ||
      labels.size !== options.length ||
      labels.has(ASK_MULTIPLE_DONE_LABEL) ||
      labels.has(ASK_CUSTOM_OPTION_LABEL)
    ) {
      throw new Error(`Choice question ${input.id} requires unique values and labels.`)
    }
    return {
      id: input.id,
      prompt: input.prompt.trim(),
      type: input.type,
      options
    }
  })
}

function normalizeOption(value: unknown): AskOption {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid ask option.')
  }
  const input = value as Record<string, unknown>
  if (
    !isBoundedString(input.value, 128) ||
    !isBoundedString(input.label, 200) ||
    (
      input.description !== undefined &&
      !isBoundedString(input.description, 500, true)
    )
  ) {
    throw new Error('Invalid ask option.')
  }
  return {
    value: input.value,
    label: input.label.trim(),
    ...(typeof input.description === 'string' && input.description.trim().length > 0
      ? { description: input.description.trim() }
      : {})
  }
}

function isBoundedString(value: unknown, maxChars: number, allowEmpty = false): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maxChars &&
    !value.includes('\0')
}

function cancelledResult(questions: AskQuestion[]) {
  const details: AskDetails = {
    version: 1,
    cancelled: true,
    questions,
    answers: []
  }
  return {
    content: [{ type: 'text' as const, text: 'User cancelled the ask interaction.' }],
    details
  }
}

function formatAnswers(answers: AskAnswer[]): string {
  const lines = answers.map((answer) => {
    const label = Array.isArray(answer.label) ? answer.label.join(', ') : answer.label
    return `- ${answer.questionId}: ${label}`
  })
  return `User answers:\n${lines.join('\n')}`
}
