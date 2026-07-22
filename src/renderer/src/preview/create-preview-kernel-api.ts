import type {
  KernelApi,
  KernelEvent,
  KernelState,
  ThinkingLevel
} from '../../../shared/kernel-contract'

const timestamp = Date.UTC(2026, 6, 21, 6, 30)

type PreviewSessionFixture = {
  summary: KernelState['sessions'][number]
  display: KernelState['session']
  conversation: KernelState['conversation']
}

type PreviewProjectFixture = {
  activeSessionKey: string
  sessions: PreviewSessionFixture[]
}

const emptyConversation: KernelState['conversation'] = {
  activeRunStartIndex: null,
  entries: []
}

const defaultModel: NonNullable<KernelState['session']['model']> = {
  provider: 'openai-codex',
  id: 'gpt-5.6-sol',
  name: 'GPT-5.6 Sol',
  reasoning: true,
  thinkingLevelMap: {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max'
  },
  contextWindow: 200_000
}

const availableModels: KernelState['availableModels'] = [
  defaultModel,
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    reasoning: true,
    thinkingLevelMap: {},
    contextWindow: 200_000
  },
  {
    provider: 'google',
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    reasoning: true,
    thinkingLevelMap: {},
    contextWindow: 1_000_000
  }
]

const previewProjects = {
  '/home/vvv/Projects/pi-gui-next': {
    activeSessionKey: '/preview/pi-gui-next/s12.jsonl',
    sessions: [
      {
        summary: {
          key: '/preview/pi-gui-next/s12.jsonl',
          id: 'preview-s12',
          name: 'S12 UI 视觉收敛',
          lastActivityAt: timestamp + 3_000
        },
        display: {
          id: 'preview-s12',
          name: 'S12 UI 视觉收敛',
          resumeAvailable: true,
          model: defaultModel,
          thinkingLevel: 'high',
          messageCount: 2,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: {
          activeRunStartIndex: null,
          entries: [
            {
              id: 'preview-user-1',
              kind: 'message',
              role: 'user',
              text: '我们先逐项调整工作台的视觉层级。',
              timestamp,
              streaming: false,
              stopReason: null,
              error: null
            },
            {
              id: 'preview-thinking-1',
              kind: 'thinking',
              text: '先检查导航、对话区域和 Composer 的空间关系。',
              timestamp: timestamp + 1_000,
              streaming: false
            },
            {
              id: 'preview-tool-1',
              kind: 'tool',
              toolCallId: 'preview-read',
              name: 'read',
              status: 'success',
              args: '{"path":"src/renderer/src/features/chat/chat.css"}',
              output: '已读取当前对话布局样式。',
              details: 'src/renderer/src/features/chat/chat.css',
              truncated: false,
              timestamp: timestamp + 2_000,
              durationMs: 86
            },
            {
              id: 'preview-assistant-1',
              kind: 'message',
              role: 'assistant',
              text: '可以。我们先从左侧 Project / Session 导航开始，一次只确认一个区域。',
              timestamp: timestamp + 3_000,
              streaming: false,
              stopReason: 'stop',
              error: null
            }
          ]
        }
      },
      {
        summary: {
          key: '/preview/pi-gui-next/s11.jsonl',
          id: 'preview-s11',
          name: 'Slash Command',
          lastActivityAt: timestamp - 28 * 60_000
        },
        display: {
          id: 'preview-s11',
          name: 'Slash Command',
          resumeAvailable: true,
          model: defaultModel,
          thinkingLevel: 'medium',
          messageCount: 8,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: emptyConversation
      },
      {
        summary: {
          key: '/preview/pi-gui-next/release.jsonl',
          id: 'preview-release',
          name: 'P1 发布复核',
          lastActivityAt: timestamp - 3 * 60 * 60_000
        },
        display: {
          id: 'preview-release',
          name: 'P1 发布复核',
          resumeAvailable: true,
          model: defaultModel,
          thinkingLevel: 'low',
          messageCount: 14,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: emptyConversation
      }
    ]
  },
  '/home/vvv/Projects/reader-next': {
    activeSessionKey: '/preview/reader-next/layout.jsonl',
    sessions: [
      {
        summary: {
          key: '/preview/reader-next/layout.jsonl',
          id: 'preview-reader-layout',
          name: '阅读器布局',
          lastActivityAt: timestamp - 16 * 60_000
        },
        display: {
          id: 'preview-reader-layout',
          name: '阅读器布局',
          resumeAvailable: true,
          model: defaultModel,
          thinkingLevel: 'high',
          messageCount: 6,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: emptyConversation
      },
      {
        summary: {
          key: '/preview/reader-next/import.jsonl',
          id: 'preview-reader-import',
          name: '文档导入',
          lastActivityAt: timestamp - 2 * 60 * 60_000
        },
        display: {
          id: 'preview-reader-import',
          name: '文档导入',
          resumeAvailable: true,
          model: defaultModel,
          thinkingLevel: 'medium',
          messageCount: 4,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: emptyConversation
      }
    ]
  },
  '/home/vvv/Projects/legal-rag': {
    activeSessionKey: '/preview/legal-rag/retrieval.jsonl',
    sessions: [
      {
        summary: {
          key: '/preview/legal-rag/retrieval.jsonl',
          id: 'preview-legal-retrieval',
          name: '检索质量复核',
          lastActivityAt: timestamp - 44 * 60_000
        },
        display: {
          id: 'preview-legal-retrieval',
          name: '检索质量复核',
          resumeAvailable: true,
          model: defaultModel,
          thinkingLevel: 'xhigh',
          messageCount: 10,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: emptyConversation
      }
    ]
  }
} satisfies Record<string, PreviewProjectFixture>

type PreviewProjectKey = keyof typeof previewProjects

type PreviewSelection = Pick<
  KernelState,
  'sessions' | 'activeSessionKey' | 'session' | 'conversation'
>

function projectSelection(projectKey: PreviewProjectKey, sessionKey?: string): PreviewSelection {
  const project = previewProjects[projectKey]
  const selectedSessionKey = sessionKey ?? project.activeSessionKey
  const selectedSession = project.sessions.find(({ summary }) => summary.key === selectedSessionKey)
  if (!selectedSession) throw new Error(`Missing preview session fixture: ${selectedSessionKey}`)

  return {
    sessions: project.sessions.map(({ summary }) => summary),
    activeSessionKey: selectedSessionKey,
    session: selectedSession.display,
    conversation: selectedSession.conversation
  }
}

const initialProjectKey: PreviewProjectKey = '/home/vvv/Projects/pi-gui-next'
const initialSelection = projectSelection(initialProjectKey)

const initialState: KernelState = {
  projects: [
    { path: '/home/vvv/Projects/pi-gui-next' },
    { path: '/home/vvv/Projects/reader-next' },
    { path: '/home/vvv/Projects/legal-rag' }
  ],
  activeProjectKey: initialProjectKey,
  ...initialSelection,
  availableModels,
  sessionNaming: { mode: 'auto' },
  commands: [
    {
      id: 'kernel.new-session',
      name: 'new',
      description: '在当前项目中新建对话',
      source: 'gui',
      argumentHint: null
    },
    {
      id: 'pi-rpc.set-model',
      name: 'model',
      description: '切换当前 Pi 模型',
      source: 'pi-rpc',
      argumentHint: '<provider/model>'
    },
    {
      id: 'pi-rpc.set-thinking-level',
      name: 'thinking',
      description: '设置思考强度',
      source: 'pi-rpc',
      argumentHint: '<low|medium|high|xhigh|max>'
    },
    {
      id: 'pi-rpc.compact',
      name: 'compact',
      description: '压缩当前 Session 上下文',
      source: 'pi-rpc',
      argumentHint: '[instructions]'
    },
    {
      id: 'pi-rpc.set-session-name',
      name: 'name',
      description: '设置当前 Session 名称',
      source: 'pi-rpc',
      argumentHint: '<name>'
    },
    {
      id: 'pi-command:skill:review',
      name: 'review',
      description: '检查当前变更并给出建议',
      source: 'skill',
      argumentHint: '[arguments]'
    }
  ],
  runtime: {
    status: 'ready',
    executable: '/home/vvv/.local/bin/pi',
    version: '0.80.10',
    stderrChars: 0,
    stderrSummary: null,
    lastError: null,
    exitCode: null,
    exitSignal: null
  },
}

export function createPreviewKernelApi(): KernelApi {
  const runningVariant = new URLSearchParams(window.location.search).get('running') === '1'
  let state = structuredClone(initialState)
  if (runningVariant) {
    state = {
      ...state,
      runtime: { ...state.runtime, status: 'running' },
      session: { ...state.session, settled: false }
    }
  }
  const listeners = new Set<(event: KernelEvent) => void>()

  const commit = (next: KernelState): Promise<KernelState> => {
    state = next
    const snapshot = structuredClone(state)
    for (const listener of listeners) listener({ type: 'kernel.state-changed', state: snapshot })
    return Promise.resolve(snapshot)
  }

  const current = (): Promise<KernelState> => Promise.resolve(structuredClone(state))

  const activateSelection = (projectKey: PreviewProjectKey, sessionKey?: string) => {
    const selection = structuredClone(projectSelection(projectKey, sessionKey))
    if (runningVariant) selection.session.settled = false
    return commit({ ...state, activeProjectKey: projectKey, ...selection })
  }

  return {
    getState: current,
    addProject: current,
    activateProject: (projectKey) =>
      projectKey in previewProjects ? activateSelection(projectKey as PreviewProjectKey) : current(),
    startSession: current,
    activateSession: (sessionKey) => {
      const projectKey = state.activeProjectKey
      if (!(projectKey && projectKey in previewProjects)) return current()
      const project = previewProjects[projectKey as PreviewProjectKey]
      return project.sessions.some(({ summary }) => summary.key === sessionKey)
        ? activateSelection(projectKey as PreviewProjectKey, sessionKey)
        : current()
    },
    prompt: current,
    abort: current,
    setModel: (provider, modelId) => {
      const model = state.availableModels.find(
        (candidate) => candidate.provider === provider && candidate.id === modelId
      )
      return model === undefined
        ? current()
        : commit({ ...state, session: { ...state.session, model: structuredClone(model) } })
    },
    setThinkingLevel: (thinkingLevel: ThinkingLevel) =>
      commit({ ...state, session: { ...state.session, thinkingLevel } }),
    setSessionNaming: (sessionNaming) => commit({ ...state, sessionNaming }),
    invokeCommand: current,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
