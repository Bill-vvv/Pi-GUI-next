import type {
  KernelApi,
  KernelEvent,
  KernelProviderCredential,
  KernelProviderConfig,
  KernelSessionUsage,
  KernelState,
  ThinkingLevel
} from '../../../shared/kernel-contract'
import { DEFAULT_SHORTCUT_SETTINGS } from '../../../shared/shortcut-settings'

const timestamp = Date.UTC(2026, 6, 21, 6, 30)
const previewProjectPaths = [
  { path: 'src', kind: 'directory' as const },
  { path: 'src/main/index.ts', kind: 'file' as const },
  { path: 'src/renderer/src/App.tsx', kind: 'file' as const },
  { path: 'docs/development-plan.md', kind: 'file' as const },
  { path: 'package.json', kind: 'file' as const }
]

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
  contextWindow: 200_000,
  pricing: {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 1.25,
    tiers: [
      {
        inputTokensAbove: 128_000,
        input: 2.5,
        output: 15,
        cacheRead: 0.25,
        cacheWrite: 2.5
      }
    ]
  }
}

const previewUsage: KernelSessionUsage = {
  inputTokens: 42_000,
  outputTokens: 3_600,
  cacheReadTokens: 18_000,
  cacheWriteTokens: 2_000,
  totalTokens: 65_600,
  contextTokens: 56_000,
  contextWindow: 200_000,
  contextPercent: 28,
  cost: 0.1842
}

const previewStatistics: NonNullable<KernelState['sessions'][number]['statistics']> = {
  userMessages: 6,
  assistantMessages: 6,
  toolCalls: 4,
  toolResults: 4,
  totalMessages: 20,
  inputTokens: previewUsage.inputTokens,
  outputTokens: previewUsage.outputTokens,
  cacheReadTokens: previewUsage.cacheReadTokens,
  cacheWriteTokens: previewUsage.cacheWriteTokens,
  totalTokens: previewUsage.totalTokens,
  cost: previewUsage.cost
}

const availableModels: KernelState['availableModels'] = [
  defaultModel,
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    reasoning: true,
    thinkingLevelMap: {},
    contextWindow: 200_000,
    pricing: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75
    }
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
        maxTokens: 16_384,
        cost: null
      }
    ]
  }
]

let previewCredentials: KernelProviderCredential[] = [
  {
    providerId: 'openai',
    providerName: 'OpenAI',
    configured: true,
    source: 'environment',
    storedCredentialType: null,
    methods: [{ type: 'api_key', name: 'OpenAI API key', label: null }]
  },
  {
    providerId: 'openai-codex',
    providerName: 'OpenAI Codex',
    configured: false,
    source: null,
    storedCredentialType: null,
    methods: [{ type: 'oauth', name: 'OpenAI Codex', label: '使用 ChatGPT 登录' }]
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
          runtimeStatus: 'ready',
          statistics: previewStatistics
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
          compaction: null,
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
          runtimeStatus: 'stopped',
          statistics: previewStatistics
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
          compaction: null,
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
          runtimeStatus: 'stopped',
          statistics: previewStatistics
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
          compaction: null,
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
          runtimeStatus: 'stopped',
          statistics: previewStatistics
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
          compaction: null,
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
          runtimeStatus: 'stopped',
          statistics: previewStatistics
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
          compaction: null,
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
          runtimeStatus: 'stopped',
          statistics: previewStatistics
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
          compaction: null,
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
  projects: (Object.keys(previewProjects) as PreviewProjectKey[]).map((path) => ({
    path,
    sessionCount: previewProjects[path].sessions.length,
    unreadCount: 0,
    sessions: previewProjects[path].sessions.map(({ summary }) => summary)
  })),
  activeProjectKey: initialProjectKey,
  ...initialSelection,
  projectTrustRequest: null,
  availableModels,
  sessionNaming: { mode: 'auto' },
  general: { startupWorkspaceRestore: 'restore', doubleClickBorderMaximize: true },
  shortcuts: { ...DEFAULT_SHORTCUT_SETTINGS },
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
  const archivedSessions = new Map<string, {
    summary: KernelState['sessions'][number]
    index: number
    preview: {
      projectKey: string
      sessionKey: string
      sessionId: string
      sessionName: string | null
      conversation: KernelState['conversation']
    }
  }>()
  let previewOperationRevision = 0

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
    return commit({
      ...state,
      activeProjectKey: projectKey,
      ...selection,
      projects: state.projects.map((project) => project.path === projectKey
        ? {
            ...project,
            sessionCount: selection.sessions.length,
            sessions: selection.sessions
          }
        : project)
    })
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
    reloadSession: async () => {
      throw new Error('Session reload is unavailable in browser preview.')
    },
    resolveProjectTrust: async () => {
      throw new Error('Project trust decisions are unavailable in browser preview.')
    },
    activateSession: (sessionKey) => {
      const projectKey = state.activeProjectKey
      if (!(projectKey && projectKey in previewProjects)) return current()
      const project = previewProjects[projectKey as PreviewProjectKey]
      return project.sessions.some(({ summary }) => summary.key === sessionKey)
        ? activateSelection(projectKey as PreviewProjectKey, sessionKey)
        : current()
    },
    archiveSession: async (sessionKey) => {
      const summary = state.sessions.find(({ key }) => key === sessionKey)
      if (summary === undefined || state.activeProjectKey === null) {
        throw new Error('Preview session is unavailable.')
      }
      const sessionIndex = state.sessions.findIndex(({ key }) => key === sessionKey)
      const project = state.activeProjectKey in previewProjects
        ? previewProjects[state.activeProjectKey as PreviewProjectKey]
        : null
      const fixture = project?.sessions.find(({ summary: candidate }) => candidate.key === sessionKey)
      const preview = {
        projectKey: state.activeProjectKey,
        sessionKey,
        sessionId: summary.id,
        sessionName: summary.name,
        conversation: structuredClone(
          state.activeSessionKey === sessionKey
            ? state.conversation
            : fixture?.conversation ?? emptyConversation
        )
      }
      const sessions = state.sessions.filter(({ key }) => key !== sessionKey)
      const projects = state.projects.map((candidate) => candidate.path === state.activeProjectKey
        ? { ...candidate, sessionCount: sessions.length, sessions }
        : candidate)
      const nextState = state.activeSessionKey !== sessionKey
        ? { ...state, sessions, projects }
        : {
            ...state,
            sessions,
            projects,
            activeSessionKey: null,
            commands: [],
            availableModels: [],
            runtime: { ...state.runtime, status: 'stopped' as const },
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
              compaction: null,
              settled: true
            },
            conversation: structuredClone(emptyConversation)
          }
      const committedState = await commit(nextState)
      previewOperationRevision += 1
      const token = `preview-archive-${previewOperationRevision}`
      archivedSessions.set(token, {
        summary: structuredClone(summary),
        index: sessionIndex,
        preview
      })
      return {
        state: committedState,
        receipt: {
          token,
          projectKey: preview.projectKey,
          sessionKey,
          sessionName: summary.name,
          durationMs: 5_000
        }
      }
    },
    undoArchiveSession: async (token) => {
      const archived = archivedSessions.get(token)
      if (archived === undefined) throw new Error('Archive receipt is unavailable.')
      archivedSessions.delete(token)
      if (state.sessions.some(({ key }) => key === archived.summary.key)) return current()
      const sessions = [...state.sessions]
      sessions.splice(Math.min(archived.index, sessions.length), 0, structuredClone(archived.summary))
      return commit({ ...state, sessions })
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
    previewArchivedSession: async (token) => {
      const archived = archivedSessions.get(token)
      if (archived === undefined) throw new Error('Archive receipt is unavailable.')
      archivedSessions.delete(token)
      return structuredClone(archived.preview)
    },
    listForkCandidates: async () => {
      if (
        state.activeSessionKey === null ||
        state.runtime.status !== 'ready' ||
        !state.session.settled
      ) return []
      return [{
        entryId: 'preview-fork-entry-1',
        text: '我们先逐项调整工作台的视觉层级。',
        timestamp: new Date(timestamp).toISOString()
      }]
    },
    forkSession: async (entryId) => {
      if (entryId !== 'preview-fork-entry-1') {
        throw new Error('Preview fork candidate is unavailable.')
      }
      previewOperationRevision += 1
      const sessionKey = `/preview/fork-${previewOperationRevision}.jsonl`
      const sessionId = `preview-fork-${previewOperationRevision}`
      const nextState = await commit({
        ...state,
        sessions: [
          {
            key: sessionKey,
            id: sessionId,
            name: '分叉预览',
            lastActivityAt: Date.now(),
            runtimeStatus: 'ready',
            statistics: previewStatistics
          },
          ...state.sessions
        ],
        activeSessionKey: sessionKey,
        session: {
          ...state.session,
          id: sessionId,
          name: '分叉预览',
          messageCount: 0,
          pendingMessageCount: 0,
          settled: true
        },
        conversation: structuredClone(emptyConversation)
      })
      return {
        state: nextState,
        draft: '我们先逐项调整工作台的视觉层级。',
        cancelled: false
      }
    },
    exportSession: async () => ({ saved: false }),
    searchProjectPaths: async (query) => {
      if (state.activeProjectKey === null) throw new Error('Preview project is unavailable.')
      const normalizedQuery = query.toLocaleLowerCase('en-US')
      return {
        projectKey: state.activeProjectKey,
        query,
        matches: previewProjectPaths.filter(({ path }) =>
          isFuzzySubsequence(path.toLocaleLowerCase('en-US'), normalizedQuery)
        )
      }
    },
    reorderProjects: (projectKeys) => {
      const projectsByKey = new Map(state.projects.map((project) => [project.path, project]))
      if (projectKeys.length !== state.projects.length || projectKeys.some((key) => !projectsByKey.has(key))) {
        return current()
      }
      return commit({ ...state, projects: projectKeys.map((key) => projectsByKey.get(key)!) })
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
    fetchModelPricing: async () => {
      throw new Error('LiteLLM pricing lookup is unavailable in browser preview.')
    },
    listProviderCredentials: async () => structuredClone(previewCredentials),
    loginProvider: async (providerId, authType) => {
      previewCredentials = previewCredentials.map((credential) => (
        credential.providerId === providerId
          ? {
              ...credential,
              configured: true,
              source: 'stored',
              storedCredentialType: authType
            }
          : credential
      ))
      return structuredClone(previewCredentials)
    },
    submitProviderAuthPrompt: async () => undefined,
    cancelProviderLogin: async () => undefined,
    logoutProvider: async (providerId) => {
      previewCredentials = previewCredentials.map((credential) => (
        credential.providerId === providerId
          ? {
              ...credential,
              configured: false,
              source: null,
              storedCredentialType: null
            }
          : credential
      ))
      return structuredClone(previewCredentials)
    },
    selectPromptAttachments: async () => [],
    getPathForFile: (file) => `/preview/${file.name}`,
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
    setShortcuts: (shortcuts) => commit({ ...state, shortcuts }),
    setAppearance: (appearance) => commit({ ...state, appearance }),
    invokeCommand: current,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    toggleFullscreen: async () => false,
    isFullscreen: async () => false,
    subscribeFullscreen: () => () => undefined,
    toggleMaximize: async () => false,
    isMaximized: async () => false,
    subscribeMaximized: () => () => undefined,
    subscribeProviderAuth: () => () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

function isFuzzySubsequence(candidate: string, query: string): boolean {
  let queryIndex = 0
  for (const character of candidate) {
    if (character !== query[queryIndex]) continue
    queryIndex += 1
    if (queryIndex === query.length) return true
  }
  return query.length === 0
}
