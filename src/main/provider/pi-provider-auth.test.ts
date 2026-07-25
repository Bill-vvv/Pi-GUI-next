import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import type { KernelProviderAuthEvent } from '../../shared/kernel-contract.ts'
import { PiProviderAuth } from './pi-provider-auth.ts'

type Interaction = {
  signal: AbortSignal
  prompt: (prompt: unknown) => Promise<string>
  notify: (event: unknown) => void
}

type CreateOptions = {
  authPath: string
  modelsPath: string
  modelsStorePath: string
  allowModelNetwork: boolean
}

class FakeRuntime {
  providers: Array<Record<string, unknown>> = [{
    id: 'example',
    name: 'Example Provider',
    auth: {
      apiKey: { name: 'Example API key', login() {} },
      oauth: { name: 'Example account', loginLabel: 'Sign in', login() {} }
    }
  }]
  statuses = new Map<string, Record<string, unknown>>([
    ['example', { configured: true, source: 'stored' }]
  ])
  credentials: Array<Record<string, unknown>> = [
    { providerId: 'example', type: 'oauth' }
  ]
  loginBehavior: (
    providerId: string,
    authType: string,
    interaction: Interaction
  ) => Promise<unknown> = async () => ({ type: 'oauth', access: 'discarded' })
  logoutBehavior: (providerId: string) => Promise<void> = async () => {}

  getProviders(): readonly Record<string, unknown>[] {
    return this.providers
  }

  getProviderAuthStatus(providerId: string): Record<string, unknown> {
    return this.statuses.get(providerId) ?? { configured: false }
  }

  async listCredentials(): Promise<readonly Record<string, unknown>[]> {
    return this.credentials
  }

  login(providerId: string, authType: string, interaction: Interaction): Promise<unknown> {
    return this.loginBehavior(providerId, authType, interaction)
  }

  logout(providerId: string): Promise<void> {
    return this.logoutBehavior(providerId)
  }
}

test('lists only redacted credential metadata and creates an offline fixed-path runtime', async (t) => {
  const agentDir = await temporaryDirectory(t)
  const runtime = new FakeRuntime()
  runtime.providers.push({
    id: 'ambient',
    name: 'Ambient Provider',
    auth: { apiKey: { name: 'Ambient credentials' } }
  })
  runtime.statuses.set('ambient', {
    configured: true,
    source: 'untrusted-source',
    label: 'must-not-cross'
  })
  runtime.credentials.push(
    { providerId: 'ambient', type: 'api_key', key: 'credential-secret' },
    { providerId: 'ignored', type: 'unknown', key: 'credential-secret' }
  )
  const created: CreateOptions[] = []
  const service = createService(agentDir, runtime, created)

  const listed = await service.list()

  assert.deepEqual(created, [{
    authPath: resolve(agentDir, 'auth.json'),
    modelsPath: resolve(agentDir, 'models.json'),
    modelsStorePath: resolve(agentDir, 'models-cache.json'),
    allowModelNetwork: false
  }])
  assert.deepEqual(listed, [
    {
      providerId: 'example',
      providerName: 'Example Provider',
      configured: true,
      source: 'stored',
      storedCredentialType: 'oauth',
      methods: [
        { type: 'api_key', name: 'Example API key', label: null },
        { type: 'oauth', name: 'Example account', label: 'Sign in' }
      ]
    },
    {
      providerId: 'ambient',
      providerName: 'Ambient Provider',
      configured: true,
      source: null,
      storedCredentialType: 'api_key',
      methods: []
    }
  ])
  assert.doesNotMatch(JSON.stringify(listed), /credential-secret|must-not-cross/)
})

test('submits exact prompts, validates selections, and never emits or throws entered secrets', async (t) => {
  const sentinel = 'secret-sentinel-value'
  const runtime = new FakeRuntime()
  runtime.loginBehavior = async (_providerId, _authType, interaction) => {
    const secret = await interaction.prompt({
      type: 'secret',
      message: 'Enter secret',
      placeholder: 'token'
    })
    interaction.notify({ type: 'progress', message: `Using ${secret}` })
    const selected = await interaction.prompt({
      type: 'select',
      message: 'Choose account',
      options: [
        { id: 'one', label: 'Account one' },
        { id: 'two', label: 'Account two', description: 'Second account' }
      ]
    })
    assert.equal(selected, 'two')
    return { type: 'api_key', key: secret }
  }
  const service = createService(await temporaryDirectory(t), runtime)
  const events: KernelProviderAuthEvent[] = []
  service.subscribe((event) => events.push(event))

  const login = service.login('example', 'api_key')
  const secretPrompt = await waitForEvent(events, 'provider-auth.prompt', 0)
  assert.equal(secretPrompt.prompt.type, 'secret')
  await assert.rejects(
    service.submitPrompt(secretPrompt.operationId, crypto.randomUUID(), sentinel),
    /no longer active/
  )
  await service.submitPrompt(secretPrompt.operationId, secretPrompt.promptId, sentinel)

  const selectPrompt = await waitForEvent(events, 'provider-auth.prompt', 1)
  assert.equal(selectPrompt.prompt.type, 'select')
  await assert.rejects(
    service.submitPrompt(selectPrompt.operationId, selectPrompt.promptId, 'missing'),
    /selection is invalid/
  )
  await service.submitPrompt(selectPrompt.operationId, selectPrompt.promptId, 'two')
  const listed = await login

  assert.doesNotMatch(JSON.stringify(events), new RegExp(sentinel))
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(sentinel))
  const notice = events.find((event) => event.type === 'provider-auth.notice')
  assert.ok(notice?.type === 'provider-auth.notice')
  assert.equal(notice.notice.type === 'progress' ? notice.notice.message : '', 'Using [REDACTED]')
})

test('cleans notices to bounded public fields', async (t) => {
  const runtime = new FakeRuntime()
  runtime.loginBehavior = async (_providerId, _authType, interaction) => {
    interaction.notify({
      type: 'info',
      message: `hello\u0000${'x'.repeat(5_000)}`,
      links: [
        { url: 'javascript:alert(1)', label: 'bad' },
        { url: 'https://example.test/path', label: 'Docs\u0001' }
      ]
    })
    interaction.notify({ type: 'auth_url', url: 'file:///tmp/private' })
    interaction.notify({
      type: 'device_code',
      userCode: 'ABC\u0000DEF',
      verificationUri: 'https://example.test/device',
      intervalSeconds: -1,
      expiresInSeconds: Number.POSITIVE_INFINITY
    })
    interaction.notify({ type: 'progress', message: 'working\u0001' })
    return { type: 'oauth', access: 'discarded' }
  }
  const service = createService(await temporaryDirectory(t), runtime)
  const events: KernelProviderAuthEvent[] = []
  service.subscribe((event) => events.push(event))

  await service.login('example', 'oauth')

  const notices = events.flatMap((event) =>
    event.type === 'provider-auth.notice' ? [event.notice] : []
  )
  assert.equal(notices.length, 3)
  assert.equal(notices[0]?.type, 'info')
  if (notices[0]?.type === 'info') {
    assert.equal(notices[0].message.length, 4_096)
    assert.deepEqual(notices[0].links, [{
      url: 'https://example.test/path',
      label: 'Docs '
    }])
  }
  assert.deepEqual(notices[1], {
    type: 'device_code',
    userCode: 'ABC DEF',
    verificationUri: 'https://example.test/device',
    intervalSeconds: null,
    expiresInSeconds: null
  })
  assert.deepEqual(notices[2], { type: 'progress', message: 'working ' })
})

test('cancels a login and rejects concurrent login attempts', async (t) => {
  const runtime = new FakeRuntime()
  runtime.loginBehavior = async (_providerId, _authType, interaction) => {
    await interaction.prompt({ type: 'text', message: 'Wait' })
    return { type: 'api_key', key: 'unused' }
  }
  const service = createService(await temporaryDirectory(t), runtime)
  const events: KernelProviderAuthEvent[] = []
  service.subscribe((event) => events.push(event))

  const login = service.login('example', 'api_key')
  assert.throws(
    () => service.login('example', 'oauth'),
    /already in progress/
  )
  const started = await waitForEvent(events, 'provider-auth.started', 0)
  await waitForEvent(events, 'provider-auth.prompt', 0)
  await service.cancel(started.operationId)
  await assert.rejects(login, { message: 'Provider login cancelled.' })
  await assert.rejects(service.cancel(started.operationId), /no longer active/)
})

test('cancel before ModelRuntime creation completes never enters the SDK login flow', async (t) => {
  const agentDir = await temporaryDirectory(t)
  const runtime = new FakeRuntime()
  let loginCalls = 0
  runtime.loginBehavior = async () => {
    loginCalls += 1
    return { type: 'api_key', key: 'unused' }
  }
  let releaseRuntime!: () => void
  const runtimeReady = new Promise<void>((resolveReady) => {
    releaseRuntime = resolveReady
  })
  const service = new PiProviderAuth({
    agentDir,
    cwd: agentDir,
    rootExports: {
      ModelRuntime: {
        async create() {
          await runtimeReady
          return runtime
        }
      }
    }
  })
  const events: KernelProviderAuthEvent[] = []
  service.subscribe((event) => events.push(event))

  const login = service.login('example', 'api_key')
  const started = await waitForEvent(events, 'provider-auth.started', 0)
  await service.cancel(started.operationId)
  releaseRuntime()

  await assert.rejects(login, { message: 'Provider login cancelled.' })
  assert.equal(loginCalls, 0)
})

test('maps SDK login and logout failures without exposing diagnostics', async (t) => {
  const runtime = new FakeRuntime()
  runtime.loginBehavior = async () => {
    throw new Error('secret-sdk-login-diagnostic')
  }
  runtime.logoutBehavior = async () => {
    throw new Error('secret-sdk-logout-diagnostic')
  }
  const service = createService(await temporaryDirectory(t), runtime)

  await assert.rejects(service.login('example', 'oauth'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Provider login failed.')
    assert.doesNotMatch(error.message, /secret-sdk/)
    return true
  })
  await assert.rejects(service.logout('example'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'Provider logout failed.')
    assert.doesNotMatch(error.message, /secret-sdk/)
    return true
  })
})

test('shutdown aborts the whole login and pending prompt', async (t) => {
  const runtime = new FakeRuntime()
  let wholeSignal: AbortSignal | undefined
  runtime.loginBehavior = async (_providerId, _authType, interaction) => {
    wholeSignal = interaction.signal
    await interaction.prompt({ type: 'manual_code', message: 'Paste code' })
    return { type: 'oauth', access: 'unused' }
  }
  const service = createService(await temporaryDirectory(t), runtime)
  const events: KernelProviderAuthEvent[] = []
  service.subscribe((event) => events.push(event))

  const login = service.login('example', 'oauth')
  await waitForEvent(events, 'provider-auth.prompt', 0)
  await service.shutdown()

  assert.equal(wholeSignal?.aborted, true)
  await assert.rejects(login, { message: 'Provider login cancelled.' })
  await assert.rejects(service.list(), /shut down/)
  await service.shutdown()
})

test('honors a per-prompt abort signal', async (t) => {
  const runtime = new FakeRuntime()
  const promptController = new AbortController()
  runtime.loginBehavior = async (_providerId, _authType, interaction) => {
    await interaction.prompt({
      type: 'text',
      message: 'Callback race',
      signal: promptController.signal
    })
    return { type: 'api_key', key: 'unused' }
  }
  const service = createService(await temporaryDirectory(t), runtime)
  const events: KernelProviderAuthEvent[] = []
  service.subscribe((event) => events.push(event))

  const login = service.login('example', 'api_key')
  await waitForEvent(events, 'provider-auth.prompt', 0)
  promptController.abort()

  await assert.rejects(login, { message: 'Provider login cancelled.' })
})

function createService(
  agentDir: string,
  runtime: FakeRuntime,
  created: CreateOptions[] = []
): PiProviderAuth {
  return new PiProviderAuth({
    agentDir,
    cwd: agentDir,
    rootExports: {
      ModelRuntime: {
        async create(options: CreateOptions) {
          created.push(options)
          return runtime
        }
      }
    }
  })
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-provider-auth-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  return directory
}

async function waitForEvent<T extends KernelProviderAuthEvent['type']>(
  events: KernelProviderAuthEvent[],
  type: T,
  occurrence: number
): Promise<Extract<KernelProviderAuthEvent, { type: T }>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const matches = events.filter((event) => event.type === type)
    const event = matches[occurrence]
    if (event) return event as Extract<KernelProviderAuthEvent, { type: T }>
    await new Promise<void>((resolveTick) => setImmediate(resolveTick))
  }
  throw new Error(`Timed out waiting for ${type}.`)
}
