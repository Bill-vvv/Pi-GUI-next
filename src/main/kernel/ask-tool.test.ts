import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASK_CUSTOM_INPUT_PLACEHOLDER,
  ASK_CUSTOM_OPTION_LABEL,
  ASK_MULTIPLE_DONE_LABEL,
  askUiRequestMatchesStep,
  createAskResponsePlan,
  normalizeAskUiRequest,
  projectAskQuestions
} from './ask-tool.ts'

test('projects bounded ask questions and rejects ambiguous options', () => {
  const questions = projectAskQuestions({
    questions: [
      {
        id: 'scope',
        prompt: 'Choose a scope',
        type: 'single',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'large', label: 'Large', description: 'All supported targets' }
        ]
      },
      {
        id: 'notes',
        prompt: 'Add constraints',
        type: 'text',
        placeholder: 'Required details'
      }
    ]
  })

  assert.deepEqual(questions, [
    {
      id: 'scope',
      prompt: 'Choose a scope',
      type: 'single',
      options: [
        { value: 'small', label: 'Small', description: null },
        { value: 'large', label: 'Large', description: 'All supported targets' }
      ],
      placeholder: null
    },
    {
      id: 'notes',
      prompt: 'Add constraints',
      type: 'text',
      options: [],
      placeholder: 'Required details'
    }
  ])

  assert.equal(projectAskQuestions({
    questions: [{
      id: 'duplicate',
      prompt: 'Choose',
      type: 'single',
      options: [
        { value: 'a', label: 'Same' },
        { value: 'b', label: 'Same' }
      ]
    }]
  }), null)
})

test('turns one answer set into the existing sequential extension UI protocol', () => {
  const questions = projectAskQuestions(JSON.stringify({
    questions: [
      {
        id: 'scope',
        prompt: 'Choose a scope',
        type: 'single',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'large', label: 'Large' }
        ]
      },
      {
        id: 'targets',
        prompt: 'Choose targets',
        type: 'multiple',
        options: [
          { value: 'linux', label: 'Linux' },
          { value: 'macos', label: 'macOS' },
          { value: 'windows', label: 'Windows' }
        ]
      },
      {
        id: 'notes',
        prompt: 'Add constraints',
        type: 'text',
        placeholder: 'Required details'
      }
    ]
  }))
  assert.notEqual(questions, null)

  const plan = createAskResponsePlan(questions!, [
    { questionId: 'notes', value: '  Keep the current layout  ' },
    { questionId: 'targets', value: ['windows', 'linux'] },
    { questionId: 'scope', value: 'large' }
  ])

  assert.deepEqual(plan.map((step) => ({
    method: step.request.method,
    title: step.request.title,
    options: step.request.method === 'select' ? step.request.options : undefined,
    placeholder: step.request.method === 'input' ? step.request.placeholder : undefined,
    value: step.value
  })), [
    {
      method: 'select',
      title: 'Ask · Choose a scope',
      options: ['Small', 'Large', ASK_CUSTOM_OPTION_LABEL],
      placeholder: undefined,
      value: 'Large'
    },
    {
      method: 'select',
      title: 'Ask · Choose targets',
      options: ['Linux', 'macOS', 'Windows', ASK_CUSTOM_OPTION_LABEL, ASK_MULTIPLE_DONE_LABEL],
      placeholder: undefined,
      value: 'Linux'
    },
    {
      method: 'select',
      title: 'Ask · Choose targets',
      options: ['macOS', 'Windows', ASK_CUSTOM_OPTION_LABEL, ASK_MULTIPLE_DONE_LABEL],
      placeholder: undefined,
      value: 'Windows'
    },
    {
      method: 'select',
      title: 'Ask · Choose targets',
      options: ['macOS', ASK_CUSTOM_OPTION_LABEL, ASK_MULTIPLE_DONE_LABEL],
      placeholder: undefined,
      value: ASK_MULTIPLE_DONE_LABEL
    },
    {
      method: 'input',
      title: 'Ask · Add constraints',
      options: undefined,
      placeholder: 'Required details',
      value: 'Keep the current layout'
    }
  ])

  const request = normalizeAskUiRequest({
    type: 'extension_ui_request',
    id: 'request-1',
    method: 'select',
    title: 'Ask · Choose a scope',
    options: ['Small', 'Large', ASK_CUSTOM_OPTION_LABEL]
  })
  assert.notEqual(request, null)
  assert.equal(askUiRequestMatchesStep(request!, plan[0]!), true)
})

test('maps custom single and multiple answers through select plus input requests', () => {
  const questions = projectAskQuestions({
    questions: [
      {
        id: 'scope',
        prompt: 'Choose a scope',
        type: 'single',
        options: [
          { value: 'small', label: 'Small' },
          { value: 'large', label: 'Large' }
        ]
      },
      {
        id: 'targets',
        prompt: 'Choose targets',
        type: 'multiple',
        options: [
          { value: 'linux', label: 'Linux' },
          { value: 'macos', label: 'macOS' }
        ]
      }
    ]
  })!

  const plan = createAskResponsePlan(questions, [
    { questionId: 'scope', value: '', customValue: 'A staged rollout' },
    { questionId: 'targets', value: ['linux'], customValue: 'FreeBSD' }
  ])

  assert.deepEqual(plan.map((step) => ({ request: step.request, value: step.value })), [
    {
      request: {
        method: 'select',
        title: 'Ask · Choose a scope',
        options: ['Small', 'Large', ASK_CUSTOM_OPTION_LABEL]
      },
      value: ASK_CUSTOM_OPTION_LABEL
    },
    {
      request: {
        method: 'input',
        title: 'Ask · Choose a scope · 其他',
        placeholder: ASK_CUSTOM_INPUT_PLACEHOLDER
      },
      value: 'A staged rollout'
    },
    {
      request: {
        method: 'select',
        title: 'Ask · Choose targets',
        options: ['Linux', 'macOS', ASK_CUSTOM_OPTION_LABEL, ASK_MULTIPLE_DONE_LABEL]
      },
      value: 'Linux'
    },
    {
      request: {
        method: 'select',
        title: 'Ask · Choose targets',
        options: ['macOS', ASK_CUSTOM_OPTION_LABEL, ASK_MULTIPLE_DONE_LABEL]
      },
      value: ASK_CUSTOM_OPTION_LABEL
    },
    {
      request: {
        method: 'input',
        title: 'Ask · Choose targets · 其他',
        placeholder: ASK_CUSTOM_INPUT_PLACEHOLDER
      },
      value: 'FreeBSD'
    },
    {
      request: {
        method: 'select',
        title: 'Ask · Choose targets',
        options: ['macOS', ASK_MULTIPLE_DONE_LABEL]
      },
      value: ASK_MULTIPLE_DONE_LABEL
    }
  ])
})

test('rejects incomplete or invalid answer sets', () => {
  const questions = projectAskQuestions({
    questions: [{
      id: 'scope',
      prompt: 'Choose a scope',
      type: 'single',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'large', label: 'Large' }
      ]
    }]
  })!

  assert.throws(() => createAskResponsePlan(questions, []), /every question/)
  assert.throws(
    () => createAskResponsePlan(questions, [{ questionId: 'scope', value: 'unknown' }]),
    /Invalid answer/
  )
})
