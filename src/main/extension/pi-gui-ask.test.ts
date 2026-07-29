import assert from 'node:assert/strict'
import test from 'node:test'

import askExtension from '../../../extensions/pi-gui-ask/src/index.ts'

test('bundled ask extension accepts custom single and multiple answers', async () => {
  let execute: ((...args: any[]) => Promise<any>) | null = null
  askExtension({
    events: null,
    on: () => undefined,
    registerTool: (tool: { execute: (...args: any[]) => Promise<any> }) => {
      execute = tool.execute
    }
  } as never)
  assert.notEqual(execute, null)

  const selections = ['其他（自行输入）', 'Linux', '其他（自行输入）', '✓ Done']
  const inputs = ['分阶段上线', 'FreeBSD']
  const selectRequests: Array<{ title: string; options: string[] }> = []
  const inputRequests: Array<{ title: string; placeholder: string | undefined }> = []
  const result = await execute!(
    'ask-1',
    {
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
    },
    AbortSignal.timeout(5_000),
    () => undefined,
    {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => {
          selectRequests.push({ title, options: [...options] })
          return selections.shift()
        },
        input: async (title: string, placeholder: string | undefined) => {
          inputRequests.push({ title, placeholder })
          return inputs.shift()
        },
        notify: () => undefined
      }
    }
  )

  assert.deepEqual(selectRequests, [
    {
      title: 'Ask · Choose a scope',
      options: ['Small', 'Large', '其他（自行输入）']
    },
    {
      title: 'Ask · Choose targets',
      options: ['Linux', 'macOS', '其他（自行输入）', '✓ Done']
    },
    {
      title: 'Ask · Choose targets',
      options: ['macOS', '其他（自行输入）', '✓ Done']
    },
    {
      title: 'Ask · Choose targets',
      options: ['macOS', '✓ Done']
    }
  ])
  assert.deepEqual(inputRequests, [
    { title: 'Ask · Choose a scope · 其他', placeholder: '请输入你的回答' },
    { title: 'Ask · Choose targets · 其他', placeholder: '请输入你的回答' }
  ])
  assert.deepEqual(result.details.answers, [
    { questionId: 'scope', value: '分阶段上线', label: '分阶段上线' },
    { questionId: 'targets', value: ['linux', 'FreeBSD'], label: ['Linux', 'FreeBSD'] }
  ])
})
