import type {
  KernelApi,
  KernelEvent,
  KernelProviderConfig,
  KernelSessionUsage,
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
    off: 'off',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max'
  },
  contextWindow: 200_000
}

const previewUsage: KernelSessionUsage = {
  inputTokens: 42_000,
  outputTokens: 3_600,
  cacheReadTokens: 18_000,
  cacheWriteTokens: 2_000,
  totalTokens: 65_600,
  contextTokens: 56_000,
  contextWindow: 200_000,
  contextPercent: 28
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

let previewProviders: KernelProviderConfig[] = [
  {
    id: 'local-openai',
    baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions',
    apiKeyConfigured: true,
    authHeader: false,
    catalogModels: [
      {
        id: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        reasoning: false,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: null
      }
    ],
    models: [
      {
        id: 'qwen2.5-coder:7b',
        name: 'Qwen 2.5 Coder 7B',
        reasoning: false,
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384
      }
    ]
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
          lastActivityAt: timestamp + 3_000,
          runtimeStatus: 'ready'
        },
        display: {
          id: 'preview-s12',
          name: 'S12 UI 视觉收敛',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'high',
          messageCount: 2,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
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
              summary: false,
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
          lastActivityAt: timestamp - 28 * 60_000,
          runtimeStatus: 'stopped'
        },
        display: {
          id: 'preview-s11',
          name: 'Slash Command',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'medium',
          messageCount: 8,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
          settled: true
        },
        conversation: emptyConversation
      },
      {
        summary: {
          key: '/preview/pi-gui-next/release.jsonl',
          id: 'preview-release',
          name: 'P1 发布复核',
          lastActivityAt: timestamp - 3 * 60 * 60_000,
          runtimeStatus: 'stopped'
        },
        display: {
          id: 'preview-release',
          name: 'P1 发布复核',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'low',
          messageCount: 14,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
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
          lastActivityAt: timestamp - 16 * 60_000,
          runtimeStatus: 'stopped'
        },
        display: {
          id: 'preview-reader-layout',
          name: '阅读器布局',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'high',
          messageCount: 6,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
          settled: true
        },
        conversation: emptyConversation
      },
      {
        summary: {
          key: '/preview/reader-next/import.jsonl',
          id: 'preview-reader-import',
          name: '文档导入',
          lastActivityAt: timestamp - 2 * 60 * 60_000,
          runtimeStatus: 'stopped'
        },
        display: {
          id: 'preview-reader-import',
          name: '文档导入',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'medium',
          messageCount: 4,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
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
          lastActivityAt: timestamp - 44 * 60_000,
          runtimeStatus: 'stopped'
        },
        display: {
          id: 'preview-legal-retrieval',
          name: '检索质量复核',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'xhigh',
          messageCount: 10,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
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
    { path: '/home/vvv/Projects/pi-gui-next', sessionCount: 3, unreadCount: 0 },
    { path: '/home/vvv/Projects/reader-next', sessionCount: 2, unreadCount: 0 },
    { path: '/home/vvv/Projects/legal-rag', sessionCount: 1, unreadCount: 0 }
  ],
  activeProjectKey: initialProjectKey,
  ...initialSelection,
  availableModels,
  sessionNaming: { mode: 'auto' },
  general: { startupWorkspaceRestore: 'restore' },
  appearance: {
    theme: 'system',
    textSize: 'default',
    accentColor: 'amber',
    surfaceTransparency: 20,
    uiFontFamily: null,
    codeFontFamily: null
  },
  extensions: [],
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
      argumentHint: '<off|minimal|low|medium|high|xhigh|max>'
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
      sessions: state.sessions.map((session) => session.key === state.activeSessionKey
        ? { ...session, runtimeStatus: 'running' }
        : session),
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
    listSystemFonts: async () => {
      throw new Error('System font discovery is unavailable in browser preview.')
    },
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
    archiveSession: (sessionKey) => {
      if (!state.sessions.some(({ key }) => key === sessionKey)) return current()
      const sessions = state.sessions.filter(({ key }) => key !== sessionKey)
      if (state.activeSessionKey !== sessionKey) return commit({ ...state, sessions })
      return commit({
        ...state,
        sessions,
        activeSessionKey: null,
        commands: [],
        availableModels: [],
        runtime: { ...state.runtime, status: 'stopped' },
        session: {
          id: null,
          name: null,
          resumeAvailable: false,
          model: null,
          usage: null,
          thinkingLevel: null,
          messageCount: 0,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
          settled: true
        },
        conversation: structuredClone(emptyConversation)
      })
    },
    previewSession: async (sessionKey) => {
      const projectKey = state.activeProjectKey
      if (!(projectKey && projectKey in previewProjects)) {
        throw new Error('Preview project is unavailable.')
      }
      const fixture = previewProjects[projectKey as PreviewProjectKey].sessions.find(
        ({ summary }) => summary.key === sessionKey
      )
      if (fixture === undefined) throw new Error('Preview session is unavailable.')
      return structuredClone({
        projectKey,
        sessionKey: fixture.summary.key,
        sessionId: fixture.summary.id,
        sessionName: fixture.summary.name,
        conversation: fixture.conversation
      })
    },
    reorderProjects: (projectKeys) => {
      const projectsByKey = new Map(state.projects.map((project) => [project.path, project]))
      if (projectKeys.length !== state.projects.length || projectKeys.some((key) => !projectsByKey.has(key))) {
        return current()
      }
      return commit({ ...state, projects: projectKeys.map((key) => projectsByKey.get(key)!) })
    },
    reorderSessions: (sessionKeys) => {
      const sessionsByKey = new Map(state.sessions.map((session) => [session.key, session]))
      if (sessionKeys.length !== state.sessions.length || sessionKeys.some((key) => !sessionsByKey.has(key))) {
        return current()
      }
      return commit({ ...state, sessions: sessionKeys.map((key) => sessionsByKey.get(key)!) })
    },
    installExtension: (kind) => {
      const path = kind === 'file'
        ? '/home/vvv/.pi/agent/extensions/sample-extension.ts'
        : '/home/vvv/.pi/agent/extensions/sample-extension'
      if (state.extensions.some((extension) => extension.path === path)) return current()
      return commit({
        ...state,
        extensions: [
          ...state.extensions,
          { path, name: 'sample-extension' }
        ]
      })
    },
    removeExtension: (path) => commit({
      ...state,
      extensions: state.extensions.filter((extension) => extension.path !== path)
    }),
    searchPiDevExtensions: async () => ({
      packages: [
        {
          name: 'pi-web-access',
          description: 'Web search and URL fetching for Pi.',
          downloads: '134.9K/mo',
          detailUrl: 'https://pi.dev/packages/pi-web-access',
          installed: false
        }
      ],
      total: 1
    }),
    searchPiDevPackages: async () => ({
      packages: [
        {
          name: 'pi-web-access',
          description: 'Web search and URL fetching for Pi.',
          downloads: '134.9K/mo',
          detailUrl: 'https://pi.dev/packages/pi-web-access',
          installed: false
        },
        {
          name: 'example-skill-pack',
          description: 'A collection of reusable skills.',
          downloads: '2.4K/mo',
          detailUrl: 'https://pi.dev/packages/example-skill-pack',
          installed: true
        }
      ],
      total: 2
    }),
    listPiPackages: async () => [
      { source: 'npm:example-skill-pack', filtered: false },
      { source: 'git:github.com/example/pi-tools', filtered: true }
    ],
    installPiDevPackage: current,
    removePiPackage: current,
    updatePiPackage: current,
    updatePiPackages: current,
    listProviders: async () => structuredClone(previewProviders),
    saveProvider: async (provider) => {
      const next = {
        id: provider.id,
        baseUrl: provider.baseUrl,
        api: provider.api,
        apiKeyConfigured: !provider.removeApiKey && (provider.apiKey !== null || (
          provider.originalId !== null &&
          previewProviders.find(({ id }) => id === provider.originalId)?.apiKeyConfigured === true
        )),
        authHeader: provider.authHeader,
        models: structuredClone(provider.models),
        catalogModels: structuredClone(
          previewProviders.find(({ id }) => id === provider.originalId)?.catalogModels ?? []
        )
      }
      previewProviders = [
        ...previewProviders.filter(({ id }) => id !== provider.originalId && id !== provider.id),
        next
      ]
      return structuredClone(previewProviders)
    },
    removeProvider: async (providerId) => {
      previewProviders = previewProviders.filter(({ id }) => id !== providerId)
      return structuredClone(previewProviders)
    },
    testProvider: async (providerId, modelId) => ({ provider: providerId, modelId, durationMs: 842 }),
    selectPromptAttachments: async () => [],
    prompt: current,
    steer: current,
    followUp: current,
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
    setGeneral: (general) => commit({ ...state, general }),
    setAppearance: (appearance) => commit({ ...state, appearance }),
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
