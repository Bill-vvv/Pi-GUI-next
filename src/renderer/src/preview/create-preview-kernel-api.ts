import {
  MAGIC_CONTEXT_PACKAGE_NAME,
  SUBAGENT_PACKAGE_NAME,
  type KernelAdvisorConfiguration,
  type KernelAdvisorDefinition,
  type KernelApi,
  type KernelMutationAck,
  type KernelSnapshot,
  type KernelEvent,
  type KernelProviderCredential,
  type KernelProviderConfig,
  type KernelSessionPreview,
  type KernelSessionUsage,
  type KernelState,
  type KernelSubagentDefinition,
  type ThinkingLevel
} from '../../../shared/kernel-contract'
import type { RemoteAdminApi } from '../../../shared/remote-admin-contract'
import { DEFAULT_SHORTCUT_SETTINGS } from '../../../shared/shortcut-settings'
import { sessionSwitchConversation } from '../composition/session-runtime-controller'

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
  startIndex: 0,
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
          awaitingUserInput: false,
          statistics: previewStatistics
        },
        display: {
          id: 'preview-s12',
          name: 'S12 UI 视觉收敛',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'high',
          openAiFastMode: false,
          messageCount: 2,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: [],
          compaction: null,
          settled: true
        },
        conversation: {
          startIndex: 0,
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
              durationMs: 86,
              subagent: null
            },
            {
              id: 'preview-assistant-1',
              kind: 'advisor',
              advisorSlug: 'accessibility',
              advisorName: 'Accessibility Advisor',
              severity: 'concern',
              guidance: '为所有图标按钮保留可读名称，并确认窄窗口下内容可以换行。',
              content: '导航调整需要同时保留键盘焦点路径与清晰的选中状态。',
              delivery: 'aside',
              timestamp: timestamp + 2_500
            },
            {
              id: 'preview-assistant-2',
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
          awaitingUserInput: false,
          statistics: previewStatistics
        },
        display: {
          id: 'preview-s11',
          name: 'Slash Command',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'medium',
          openAiFastMode: false,
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
          awaitingUserInput: false,
          statistics: previewStatistics
        },
        display: {
          id: 'preview-release',
          name: 'P1 发布复核',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'low',
          openAiFastMode: false,
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
          awaitingUserInput: false,
          statistics: previewStatistics
        },
        display: {
          id: 'preview-reader-layout',
          name: '阅读器布局',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'high',
          openAiFastMode: false,
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
          awaitingUserInput: false,
          statistics: previewStatistics
        },
        display: {
          id: 'preview-reader-import',
          name: '文档导入',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'medium',
          openAiFastMode: false,
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
          awaitingUserInput: false,
          statistics: previewStatistics
        },
        display: {
          id: 'preview-legal-retrieval',
          name: '检索质量复核',
          resumeAvailable: true,
          model: defaultModel,
          usage: previewUsage,
          thinkingLevel: 'xhigh',
          openAiFastMode: false,
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
    sessions: previewProjects[path].sessions.map(({ summary }) => summary)
  })),
  activeProjectKey: initialProjectKey,
  ...initialSelection,
  projectTrustRequest: null,
  availableModels,
  sessionNaming: { mode: 'auto' },
  general: {
    startupWorkspaceRestore: 'restore',
    doubleClickBorderMaximize: true,
    fastExtensionLoading: false,
    autoContinueInterruptedTasks: false
  },
  subagent: { maxDepth: 3 },
  shortcuts: { ...DEFAULT_SHORTCUT_SETTINGS },
  advisor: {
    compatibility: 'ready',
    extensionVersion: '1.0.0',
    systemEnabled: true,
    liveToggle: true,
    multiAdvisor: true,
    roster: true,
    error: null
  },
  appearance: {
    theme: 'system',
    textSize: 'default',
    tokenCountFormat: 'full',
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
      argumentHint: null,
      sourceInfo: null
    },
    {
      id: 'pi-rpc.set-model',
      name: 'model',
      description: '切换当前 Pi 模型',
      source: 'pi-rpc',
      argumentHint: '<provider/model>',
      sourceInfo: null
    },
    {
      id: 'pi-rpc.set-thinking-level',
      name: 'thinking',
      description: '设置思考强度',
      source: 'pi-rpc',
      argumentHint: '<off|minimal|low|medium|high|xhigh|max>',
      sourceInfo: null
    },
    {
      id: 'pi-rpc.compact',
      name: 'compact',
      description: '压缩当前 Session 上下文',
      source: 'pi-rpc',
      argumentHint: '[instructions]',
      sourceInfo: null
    },
    {
      id: 'pi-rpc.set-session-name',
      name: 'name',
      description: '设置当前 Session 名称',
      source: 'pi-rpc',
      argumentHint: '<name>',
      sourceInfo: null
    },
    {
      id: 'pi-command:skill:review',
      name: 'review',
      description: '检查当前变更并给出建议',
      source: 'skill',
      argumentHint: '[arguments]',
      sourceInfo: {
        source: 'local',
        scope: 'project',
        origin: 'top-level'
      }
    }
  ],
  runtime: {
    status: 'ready',
    executable: '/home/vvv/.local/bin/pi',
    version: '0.83.0',
    stderrChars: 0,
    stderrSummary: null,
    lastError: null,
    exitCode: null,
    exitSignal: null
  },
}

export function createPreviewRemoteAdminApi(): RemoteAdminApi {
  return {
    getStatus: async () => ({ enabled: false }),
    createPairingCode: async () => {
      throw new Error('Remote access is disabled in browser preview.')
    },
    revokeDevice: async () => {
      throw new Error('Remote access is disabled in browser preview.')
    }
  }
}

export function createPreviewKernelApi(): KernelApi {
  const runningVariant = new URLSearchParams(window.location.search).get('running') === '1'
  let state = structuredClone(initialState)
  let installedPackages = [
    {
      source: 'npm:example-skill-pack',
      packageName: 'example-skill-pack',
      filtered: false,
      extensionEnabled: true
    },
    {
      source: 'git:github.com/example/pi-tools',
      packageName: null,
      filtered: true,
      extensionEnabled: false
    },
    {
      source: `npm:${SUBAGENT_PACKAGE_NAME}@1.0.0`,
      packageName: SUBAGENT_PACKAGE_NAME,
      filtered: false,
      extensionEnabled: true
    },
    {
      source: `npm:${MAGIC_CONTEXT_PACKAGE_NAME}@1.0.0`,
      packageName: MAGIC_CONTEXT_PACKAGE_NAME,
      filtered: true,
      extensionEnabled: false
    },
    {
      source: 'npm:pi-gui-multi-advisor@1.0.0',
      packageName: 'pi-gui-multi-advisor',
      filtered: false,
      extensionEnabled: true
    }
  ]
  let subagentDefinitions: KernelSubagentDefinition[] = [
    {
      id: 'builtin:c2NvdXQubWQ',
      scope: 'builtin',
      editable: false,
      enabled: true,
      name: 'scout',
      description: '快速检索并理解当前代码库',
      systemPrompt: '快速定位与任务相关的文件、符号和约束，返回精确出处。',
      model: null,
      fallbackModels: null,
      thinking: 'low',
      systemPromptMode: 'replace',
      inheritProjectContext: true,
      inheritSkills: false,
      defaultContext: 'fresh',
      tools: ['read', 'grep', 'find'],
      skills: null,
      defaultAsync: null,
      timeoutMs: null,
      maxTurns: 12,
      maxSubagentDepth: null
    },
    {
      id: 'builtin:cmV2aWV3ZXIubWQ',
      scope: 'builtin',
      editable: false,
      enabled: true,
      name: 'reviewer',
      description: '审查实现并指出明确、可执行的问题',
      systemPrompt: '检查正确性、回归风险和边界条件，优先报告有证据的问题。',
      model: null,
      fallbackModels: null,
      thinking: 'high',
      systemPromptMode: 'replace',
      inheritProjectContext: true,
      inheritSkills: false,
      defaultContext: 'fresh',
      tools: ['read', 'grep', 'bash'],
      skills: null,
      defaultAsync: null,
      timeoutMs: null,
      maxTurns: 20,
      maxSubagentDepth: null
    },
    {
      id: 'project:c2VjdXJpdHktcmV2aWV3ZXIubWQ',
      scope: 'project',
      editable: true,
      enabled: true,
      name: 'security-reviewer',
      description: '检查鉴权、输入校验与敏感信息泄漏',
      systemPrompt: '只进行安全审查。按严重度列出问题，并给出文件与行号。',
      model: 'openai-codex/gpt-5.6-sol',
      fallbackModels: null,
      thinking: 'high',
      systemPromptMode: 'replace',
      inheritProjectContext: true,
      inheritSkills: false,
      defaultContext: 'fresh',
      tools: ['read', 'grep'],
      skills: null,
      defaultAsync: false,
      timeoutMs: 120000,
      maxTurns: 16,
      maxSubagentDepth: 0
    }
  ]
  let advisorConfiguration: KernelAdvisorConfiguration = {
    definitions: [
      {
        id: 'builtin:default-advisor',
        slug: 'default-advisor',
        scope: 'builtin',
        sourcePath: null,
        sourceOrder: 0,
        editable: false,
        name: 'Default Advisor',
        enabled: true,
        model: 'gpt-5.6-sol',
        thinking: 'medium',
        tools: ['read', 'grep', 'find', 'ls'],
        instructions: 'Review the current response for correctness and concrete risks.'
      },
      {
        id: 'inherited:2:accessibility',
        slug: 'accessibility',
        scope: 'inherited',
        sourcePath: '/home/vvv/Projects/WATCHDOG.yml',
        sourceOrder: 2,
        editable: false,
        name: 'Accessibility',
        enabled: true,
        model: null,
        thinking: 'high',
        tools: ['read', 'grep', 'find'],
        instructions: 'Check keyboard paths, accessible names, focus order, and narrow-window behavior.'
      },
      {
        id: 'project:3:implementation-safety',
        slug: 'implementation-safety',
        scope: 'project',
        sourcePath: '/home/vvv/Projects/pi-gui-next/WATCHDOG.yml',
        sourceOrder: 3,
        editable: true,
        name: 'Implementation Safety',
        enabled: true,
        model: 'openai-codex/gpt-5.6-sol',
        thinking: 'xhigh',
        tools: ['read', 'grep', 'find', 'edit'],
        instructions: 'Inspect the implementation boundary and report regressions with precise evidence.'
      }
    ],
    sources: [
      {
        id: 'builtin:default-advisor',
        scope: 'builtin',
        path: null,
        sourceOrder: 0,
        editable: false,
        instructions: ''
      },
      {
        id: 'user:1',
        scope: 'user',
        path: '/home/vvv/.pi/agent/WATCHDOG.md',
        sourceOrder: 1,
        editable: true,
        instructions: 'Prefer concise, actionable findings with evidence.'
      },
      {
        id: 'inherited:2',
        scope: 'inherited',
        path: '/home/vvv/Projects/WATCHDOG.yml',
        sourceOrder: 2,
        editable: false,
        instructions: 'Apply repository-wide accessibility and safety constraints.'
      },
      {
        id: 'project:3',
        scope: 'project',
        path: '/home/vvv/Projects/pi-gui-next/WATCHDOG.yml',
        sourceOrder: 3,
        editable: true,
        instructions: 'Respect the current Pi GUI architecture and frontend guidelines.'
      }
    ],
    diagnostics: [
      {
        sourcePath: '/home/vvv/Projects/pi-gui-next/.omp/WATCHDOG.yml',
        message: 'Preview diagnostic: inherited sample source was skipped.'
      }
    ]
  }
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
      conversation: KernelSessionPreview['conversation']
    }
  }>()
  const staticSessionPreviews = new Map<string, KernelSessionPreview>()
  let previewOperationRevision = 0

  let stateRevision = 0

  const acknowledge = (): KernelMutationAck => ({ revision: stateRevision })

  const commit = (next: KernelState): Promise<KernelMutationAck> => {
    state = next
    stateRevision += 1
    const snapshot = structuredClone(state)
    for (const listener of listeners) {
      listener({ type: 'kernel.state-changed', revision: stateRevision, state: snapshot })
    }
    return Promise.resolve(acknowledge())
  }

  const current = (): Promise<KernelSnapshot> => Promise.resolve({
    revision: stateRevision,
    state: structuredClone(state)
  })
  const currentAck = (): Promise<KernelMutationAck> => Promise.resolve(acknowledge())

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
    getRuntimeMemoryDiagnostics: async () => ({
      sampledAt: Date.now(),
      runtimes: []
    }),
    listSystemFonts: async () => {
      throw new Error('System font discovery is unavailable in browser preview.')
    },
    addProject: currentAck,
    activateProject: (projectKey) =>
      projectKey in previewProjects ? activateSelection(projectKey as PreviewProjectKey) : currentAck(),
    refreshWorkspaceMetadata: currentAck,
    selectNavigator: (kind) => commit({ ...state, navigatorKind: kind }),
    createTask: currentAck,
    activateTask: currentAck,
    startSession: currentAck,
    reloadSession: async () => {
      throw new Error('Session reload is unavailable in browser preview.')
    },
    resolveProjectTrust: async () => {
      throw new Error('Project trust decisions are unavailable in browser preview.')
    },
    activateSession: (sessionKey) => {
      const projectKey = state.activeProjectKey
      if (!(projectKey && projectKey in previewProjects)) return currentAck()
      const project = previewProjects[projectKey as PreviewProjectKey]
      return project.sessions.some(({ summary }) => summary.key === sessionKey)
        ? activateSelection(projectKey as PreviewProjectKey, sessionKey)
        : currentAck()
    },
    loadEarlierConversation: async () => {
      throw new Error('Conversation pagination is unavailable in browser preview.')
    },
    getLastAssistantFinalAnswer: async () => {
      if (state.activeProjectKey === null || state.activeSessionKey === null || state.session.id === null) {
        throw new Error('Preview session is unavailable.')
      }
      const answer = [...state.conversation.entries].reverse().find((entry) =>
        entry.kind === 'message' &&
        entry.role === 'assistant' &&
        !entry.streaming &&
        (entry.phase === 'final_answer' || entry.phase == null) &&
        entry.text.trim().length > 0
      )
      return {
        projectKey: state.activeProjectKey,
        sessionKey: state.activeSessionKey,
        sessionId: state.session.id,
        text: answer?.kind === 'message' ? answer.text : null
      }
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
      const preview: KernelSessionPreview = {
        projectKey: state.activeProjectKey,
        sessionKey,
        sessionId: summary.id,
        sessionName: summary.name,
        conversation: sessionSwitchConversation(structuredClone(
          state.activeSessionKey === sessionKey
            ? state.conversation
            : fixture?.conversation ?? emptyConversation
        ))
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
              openAiFastMode: false,
              messageCount: 0,
              pendingMessageCount: 0,
              pendingSteeringMessages: [],
              pendingFollowUpMessages: [],
              compaction: null,
              settled: true
            },
            conversation: structuredClone(emptyConversation)
          }
      const ack = await commit(nextState)
      previewOperationRevision += 1
      const token = `preview-archive-${previewOperationRevision}`
      archivedSessions.set(token, {
        summary: structuredClone(summary),
        index: sessionIndex,
        preview
      })
      return {
        ...ack,
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
      if (state.sessions.some(({ key }) => key === archived.summary.key)) return currentAck()
      const sessions = [...state.sessions]
      sessions.splice(Math.min(archived.index, sessions.length), 0, structuredClone(archived.summary))
      return commit({ ...state, sessions })
    },
    previewSession: async (sessionKey, requestId) => {
      const projectKey = state.activeProjectKey
      if (!(projectKey && projectKey in previewProjects)) {
        throw new Error('Preview project is unavailable.')
      }
      const fixture = previewProjects[projectKey as PreviewProjectKey].sessions.find(
        ({ summary }) => summary.key === sessionKey
      )
      if (fixture === undefined) throw new Error('Preview session is unavailable.')
      const preview = structuredClone({
        projectKey,
        sessionKey: fixture.summary.key,
        sessionId: fixture.summary.id,
        sessionName: fixture.summary.name,
        conversation: sessionSwitchConversation(fixture.conversation)
      })
      staticSessionPreviews.clear()
      staticSessionPreviews.set(requestId, preview)
      return structuredClone(preview)
    },
    completeSessionPreview: async (requestId) => {
      const preview = staticSessionPreviews.get(requestId)
      if (preview === undefined) throw new Error('Session preview request is not active.')
      staticSessionPreviews.delete(requestId)
      return structuredClone(preview)
    },
    cancelSessionPreview: async (requestId) => {
      staticSessionPreviews.delete(requestId)
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
      const ack = await commit({
        ...state,
        sessions: [
          {
            key: sessionKey,
            id: sessionId,
            name: '分叉预览',
            lastActivityAt: Date.now(),
            runtimeStatus: 'ready',
            awaitingUserInput: false,
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
        ...ack,
        draft: '我们先逐项调整工作台的视觉层级。',
        cancelled: false
      }
    },
    exportSession: async () => ({ saved: false }),
    getMessageImage: async () => {
      throw new Error('Preview mode does not include session image payloads.')
    },
    getToolImage: async () => {
      throw new Error('Preview mode does not include tool image payloads.')
    },
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
        return currentAck()
      }
      return commit({ ...state, projects: projectKeys.map((key) => projectsByKey.get(key)!) })
    },
    installExtension: (kind) => {
      const path = kind === 'file'
        ? '/home/vvv/.pi/agent/extensions/sample-extension.ts'
        : '/home/vvv/.pi/agent/extensions/sample-extension'
      if (state.extensions.some((extension) => extension.path === path)) return currentAck()
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
    listPiPackages: async () => structuredClone(installedPackages),
    listPiPackageInstallJobs: async () => [],
    installPiDevPackage: (name) => {
      const source = `npm:${name}`
      if (!installedPackages.some((pkg) => pkg.source === source || pkg.source.startsWith(`${source}@`))) {
        installedPackages = [
          ...installedPackages,
          { source, packageName: name, filtered: false, extensionEnabled: true }
        ]
      }
      return currentAck()
    },
    removePiPackage: (source) => {
      installedPackages = installedPackages.filter((pkg) => pkg.source !== source)
      return currentAck()
    },
    setSubagentEnabled: async (enabled) => {
      const base = `npm:${SUBAGENT_PACKAGE_NAME}`
      if (!installedPackages.some((pkg) => pkg.source === base || pkg.source.startsWith(`${base}@`))) {
        throw new Error('Subagent Package is not installed.')
      }
      installedPackages = installedPackages.map((pkg) =>
        pkg.source === base || pkg.source.startsWith(`${base}@`)
          ? { ...pkg, extensionEnabled: enabled }
          : pkg
      )
      return structuredClone(installedPackages)
    },
    setMagicContextEnabled: async (enabled) => {
      const base = `npm:${MAGIC_CONTEXT_PACKAGE_NAME}`
      if (!installedPackages.some((pkg) => pkg.source === base || pkg.source.startsWith(`${base}@`))) {
        throw new Error('Magic Context Package is not installed.')
      }
      installedPackages = installedPackages.map((pkg) =>
        pkg.source === base || pkg.source.startsWith(`${base}@`)
          ? { ...pkg, extensionEnabled: enabled }
          : pkg
      )
      return structuredClone(installedPackages)
    },
    setAdvisorSystemEnabled: (enabled) => commit({
      ...state,
      advisor: {
        ...state.advisor,
        systemEnabled: enabled
      }
    }),
    setAdvisorExtensionEnabled: async (enabled) => {
      const matches = installedPackages.filter(({ source }) => isAdvisorPackageSource(source))
      if (matches.length !== 1) {
        throw new Error('Advisor Package must have exactly one installed source.')
      }
      installedPackages = installedPackages.map((pkg) =>
        isAdvisorPackageSource(pkg.source) ? { ...pkg, extensionEnabled: enabled } : pkg
      )
      return structuredClone(installedPackages)
    },
    listAdvisorDefinitions: async () => structuredClone(advisorConfiguration),
    saveAdvisorDefinition: async (input) => {
      const slug = slugifyAdvisorName(input.name)
      const originalIndex = input.originalSlug === null
        ? -1
        : advisorConfiguration.definitions.findIndex((definition) =>
            definition.editable &&
            definition.scope === input.scope &&
            definition.slug === input.originalSlug
          )
      if (input.originalSlug !== null && originalIndex === -1) {
        throw new Error('Advisor definition no longer exists in the selected scope.')
      }
      if (advisorConfiguration.definitions.some((definition, index) =>
        index !== originalIndex &&
        definition.editable &&
        definition.scope === input.scope &&
        definition.slug === slug
      )) {
        throw new Error(`Advisor definition already exists: ${slug}`)
      }
      const sourceOrder = input.scope === 'project' ? 3 : 1
      const sourcePath = input.scope === 'project'
        ? '/home/vvv/Projects/pi-gui-next/WATCHDOG.yml'
        : '/home/vvv/.pi/agent/WATCHDOG.yml'
      const next: KernelAdvisorDefinition = {
        id: `${input.scope}:${sourceOrder}:${slug}`,
        slug,
        scope: input.scope,
        sourcePath,
        sourceOrder,
        editable: true,
        name: input.name,
        enabled: input.enabled,
        model: input.model,
        thinking: input.thinking,
        tools: [...input.tools],
        instructions: input.instructions
      }
      advisorConfiguration = {
        ...advisorConfiguration,
        definitions: originalIndex === -1
          ? [...advisorConfiguration.definitions, next]
          : advisorConfiguration.definitions.map((definition, index) =>
              index === originalIndex ? next : definition
            )
      }
      return structuredClone(advisorConfiguration)
    },
    removeAdvisorDefinition: async (slug, scope) => {
      const index = advisorConfiguration.definitions.findIndex((definition) =>
        definition.editable &&
        definition.scope === scope &&
        definition.slug === slug
      )
      if (index === -1) throw new Error('Advisor definition no longer exists.')
      advisorConfiguration = {
        ...advisorConfiguration,
        definitions: advisorConfiguration.definitions.filter((_, candidate) => candidate !== index)
      }
      return structuredClone(advisorConfiguration)
    },
    listSubagentDefinitions: async () => structuredClone(subagentDefinitions),
    saveSubagentDefinition: async (definition) => {
      const { originalId, ...fields } = definition
      const original = originalId === null
        ? null
        : subagentDefinitions.find((item) => item.id === originalId) ?? null
      const id = originalId ?? `${definition.scope}:${btoa(`${definition.name}.md`)
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_')
        .replace(/=+$/gu, '')}`
      const next: KernelSubagentDefinition = {
        ...fields,
        id,
        editable: true,
        enabled: original?.enabled ?? true
      }
      const originalIndex = originalId === null
        ? -1
        : subagentDefinitions.findIndex((item) => item.id === originalId)
      subagentDefinitions = originalIndex === -1
        ? [...subagentDefinitions, next]
        : subagentDefinitions.map((item, index) => index === originalIndex ? next : item)
      return structuredClone(subagentDefinitions)
    },
    setSubagentDefinitionEnabled: async (id, _scope, enabled) => {
      subagentDefinitions = subagentDefinitions.map((definition) =>
        definition.id === id ? { ...definition, enabled } : definition
      )
      return structuredClone(subagentDefinitions)
    },
    removeSubagentDefinition: async (id) => {
      subagentDefinitions = subagentDefinitions.filter((definition) => definition.id !== id)
      return structuredClone(subagentDefinitions)
    },
    updatePiPackage: currentAck,
    updatePiPackages: currentAck,
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
    submitAsk: currentAck,
    cancelAsk: currentAck,
    navigateHistoryPrompt: currentAck,
    prompt: currentAck,
    steer: currentAck,
    followUp: currentAck,
    abort: currentAck,
    setModel: (provider, modelId) => {
      const model = state.availableModels.find(
        (candidate) => candidate.provider === provider && candidate.id === modelId
      )
      return model === undefined
        ? currentAck()
        : commit({ ...state, session: { ...state.session, model: structuredClone(model) } })
    },
    setThinkingLevel: (thinkingLevel: ThinkingLevel) =>
      commit({ ...state, session: { ...state.session, thinkingLevel } }),
    setOpenAiFastMode: (openAiFastMode) =>
      commit({ ...state, session: { ...state.session, openAiFastMode } }),
    setSessionNaming: (sessionNaming) => commit({ ...state, sessionNaming }),
    setGeneral: (general) => commit({
      ...state,
      general: { ...state.general, ...general }
    }),
    setSubagent: (subagent) => commit({ ...state, subagent }),
    setShortcuts: (shortcuts) => commit({ ...state, shortcuts }),
    setAppearance: (appearance) => commit({ ...state, appearance }),
    invokeCommand: currentAck,
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

function isAdvisorPackageSource(source: string): boolean {
  if (source === 'pi-gui-multi-advisor') return true
  if (/^npm:pi-gui-multi-advisor(?:@[^/]+)?$/u.test(source)) return true
  if (!(
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~/') ||
    source.startsWith('\\\\') ||
    /^[a-z]:[\\/]/iu.test(source) ||
    (!/^[a-z][a-z0-9+.-]*:/iu.test(source) && /[\\/]/u.test(source))
  )) return false
  const normalized = source.replace(/[\\/]+$/u, '')
  return normalized.length > 0 &&
    normalized.split(/[\\/]/u).at(-1) === 'pi-gui-multi-advisor'
}

function slugifyAdvisorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'advisor'
}
