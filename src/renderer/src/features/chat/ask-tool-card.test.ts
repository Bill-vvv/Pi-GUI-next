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
const { AskToolCard, buildAskAnswers, summarizeAskDraft } = askCardModule

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

test('Ask card presents explicit question navigation before the review step', () => {
  const html = renderToStaticMarkup(createElement(AskToolCard, {
    ask,
    entry,
    interaction: null
  }))

  assert.match(html, /第 1 \/ 2 题 · 已回答 0/)
  assert.match(html, /aria-label="问卷步骤"/)
  assert.match(html, /aria-current="step"/)
  assert.match(html, /确认回答，已完成 0 \/ 2 题/)
  assert.match(html, /选择范围/)
  assert.match(html, /自行输入一个答案/)
  assert.match(html, />下一题<\/button>/)
  assert.equal(html.match(/<fieldset/g)?.length, 1)
  assert.doesNotMatch(html, /role="progressbar"/)
})

test('Ask review summaries use display labels and preserve custom answers', () => {
  assert.equal(summarizeAskDraft(questions[0]!, {
    value: 'large',
    customSelected: false,
    customValue: ''
  }), '完整范围')
  assert.equal(summarizeAskDraft(questions[0]!, {
    value: '',
    customSelected: true,
    customValue: '分阶段上线'
  }), '分阶段上线')
  assert.equal(summarizeAskDraft(questions[1]!, {
    value: ['linux'],
    customSelected: true,
    customValue: 'FreeBSD'
  }), 'Linux、FreeBSD')
  assert.equal(summarizeAskDraft(questions[1]!, {
    value: [],
    customSelected: false,
    customValue: ''
  }), null)
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
