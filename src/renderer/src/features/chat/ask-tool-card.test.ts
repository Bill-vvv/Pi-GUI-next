import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import type {
  KernelAskQuestion,
  KernelAskToolState,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false }
})
after(async () => vite.close())

const askCardModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/AskToolCard.tsx'
) as typeof import('./AskToolCard.tsx')
const { AskToolCard, buildAskAnswers } = askCardModule

const questions: KernelAskQuestion[] = [
  {
    id: 'scope',
    prompt: '选择范围',
    type: 'single',
    options: [
      { value: 'small', label: '小范围', description: null },
      { value: 'large', label: '完整范围', description: '包含所有目标' }
    ],
    placeholder: null
  },
  {
    id: 'targets',
    prompt: '选择目标',
    type: 'multiple',
    options: [{ value: 'linux', label: 'Linux', description: null }],
    placeholder: null
  }
]

const ask: KernelAskToolState = {
  questions,
  status: 'waiting',
  error: null
}

const entry = {
  kind: 'tool',
  toolCallId: 'ask-1',
  name: 'ask',
  status: 'running'
} as KernelToolEntry

test('Ask card presents one question at a time with a custom-answer option', () => {
  const html = renderToStaticMarkup(createElement(AskToolCard, {
    ask,
    entry,
    interaction: null
  }))

  assert.match(html, /第 1 \/ 2 题/)
  assert.match(html, /选择范围/)
  assert.match(html, /自行输入一个答案/)
  assert.doesNotMatch(html, /选择目标/)
  assert.match(html, /aria-valuenow="1"/)
})

test('Ask answer projection keeps custom text separate from fixed option values', () => {
  assert.deepEqual(buildAskAnswers(questions, {
    scope: {
      value: '',
      customSelected: true,
      customValue: '分阶段上线'
    },
    targets: {
      value: ['linux'],
      customSelected: true,
      customValue: 'FreeBSD'
    }
  }), [
    { questionId: 'scope', value: '', customValue: '分阶段上线' },
    { questionId: 'targets', value: ['linux'], customValue: 'FreeBSD' }
  ])
})
