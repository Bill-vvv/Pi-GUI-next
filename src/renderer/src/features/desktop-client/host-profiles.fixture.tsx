import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { DesktopClientApi, DesktopClientConnectRequest, DesktopClientStatus, DesktopHostProfile, DesktopHostProfileCommand } from '../../../../shared/desktop-client-contract'
import { ConnectHostPanel } from './ConnectHostPanel'
import '../../tokens.css'
import '../../styles.css'

export async function runHostProfileChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const previous = window.piDesktopClient
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const commands: DesktopHostProfileCommand[] = []
  const connects: DesktopClientConnectRequest[] = []
  const a: DesktopHostProfile = { id: crypto.randomUUID(), name: '开发主机', config: { sshHostAlias: 'host-a', localPort: 18001, desktopHostPort: 18788 } }
  const b: DesktopHostProfile = { id: crypto.randomUUID(), name: '测试主机'.repeat(15), config: { sshHostAlias: 'host-b', localPort: 18002, desktopHostPort: 18789 } }
  const status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'disconnected', lastHost: a.config, hasStoredCredential: true,
    capabilities: null, error: null, failureKind: null, recovery: null,
    hostProfiles: { revision: 1, selectedId: a.id, profiles: [a, b], ready: true }
  }
  let complete!: () => void
  let fail!: (error: Error) => void
  window.piDesktopClient = { manageHostProfiles: async (command) => {
    commands.push(command)
    await new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
  } } as DesktopClientApi
  const check = (condition: unknown, label: string): void => { if (!condition) throw new Error(label); checks.push(label) }
  const render = async (): Promise<void> => { await act(async () => root.render(<StrictMode><ConnectHostPanel status={{ ...status, hostProfiles: { ...status.hostProfiles! } }}
    busy={false} error={null} onConnect={async (request) => { connects.push(request) }} /></StrictMode>)) }
  const field = (name: string): HTMLInputElement => container.querySelector(`[name="${name}"]`)!
  const button = (label: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!
  const input = async (name: string, value: string): Promise<void> => { await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(name), value)
    field(name).dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()) }
  const submit = async (): Promise<void> => { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
  const apply = async (selectedId: string | null, paired: boolean): Promise<void> => {
    status.phase = 'disconnected'
    status.hasStoredCredential = paired
    status.hostProfiles!.revision++
    status.hostProfiles!.selectedId = selectedId
    status.lastHost = status.hostProfiles!.profiles.find((profile) => profile.id === selectedId)?.config ?? null
    await render()
    await act(async () => complete())
  }
  const choose = async (name: string): Promise<void> => {
    await click(container.querySelector<HTMLElement>('section[aria-label="已保存的主机"] button[aria-haspopup="listbox"]')!)
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent!.includes(name))!
    await click(option)
  }
  try {
    await render()
    await submit()
    check(field('sshHostAlias').value === 'host-a' && field('profileName').value === a.name && connects[0]?.profile?.id === a.id && connects[0]?.profile?.revision === 1,
      'Saved selection fills its fields and connection carries the observed profile and revision')
    await input('sshHostAlias', 'edited-host')
    await input('profileName', '编辑后的主机')
    await input('pairingCode', '123456')
    await submit()
    check(connects.length === 1 && container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, 'Unsaved edits cannot connect or reuse the selected Host credential')
    await act(async () => { button('保存主机配置').click(); button('保存主机配置').click() })
    check(commands.length === 1 && commands[0]!.type === 'desktop-client.host-profiles.save' && commands[0]!.id === a.id &&
      commands[0]!.expectedRevision === 1 && !JSON.stringify(commands[0]).includes('pairingCode'), 'Save is sent once with target and revision, without pairing codes or secrets')
    status.phase = 'configuring'; await render()
    check([...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every((element) => element.disabled), 'Configuration writes lock fields, discovery, checking and connecting')
    a.name = '编辑后的主机'; a.config.sshHostAlias = 'edited-host'
    await apply(a.id, false)
    check(field('pairingCode').value === '' && field('pairingCode').required && field('profileName').value === a.name,
      'Authoritative endpoint changes clear old pairing codes and require new pairing')
    await input('pairingCode', '654321')
    await choose('测试主机')
    check(commands.at(-1)?.type === 'desktop-client.host-profiles.select' && (commands.at(-1) as { id: string }).id === b.id,
      'Selecting another saved Host uses the typed selection operation')
    await apply(b.id, true)
    check(field('sshHostAlias').value === 'host-b' && field('localPort').value === '18002' && field('pairingCode').value === '' && !field('pairingCode').required,
      'Selection restores the other Host ports and credential availability without carrying a pairing code')
    check(container.scrollWidth <= window.innerWidth && container.querySelector('form')!.getBoundingClientRect().right <= window.innerWidth,
      'Long saved Host names and profile actions fit the current viewport')
    await click(button('删除配置'))
    const count = commands.length
    check(container.textContent!.includes('不会撤销 Host 上的配对') && commands.length === count && button('确认删除') !== undefined,
      'Local deletion explains its scope and waits for explicit confirmation')
    await click(button('取消'))
    check(!container.textContent!.includes('确认删除') && document.activeElement === button('删除配置'), 'Cancelling deletion restores focus and preserves the saved Host')
    await click(button('忘记凭证'))
    await click(button('确认忘记'))
    check(commands.at(-1)!.type === 'desktop-client.host-profiles.forget', 'Forgetting a credential has its own operation and does not request remote logout')
    status.hostProfiles!.revision++; status.hostProfiles!.ready = false; status.hasStoredCredential = false
    status.error = '主机配置或凭证操作未完成，请重试：Credential Manager unavailable'
    await render()
    await act(async () => fail(new Error('Credential Manager unavailable')))
    check(!button('重试配置与凭证操作').disabled && button('保存主机配置').disabled && container.querySelector('[role="alert"]')!.textContent!.includes('Credential Manager'),
      'A partial credential failure exposes retry while blocking new connections and edits')
    await click(button('重试配置与凭证操作'))
    check(commands.at(-1)!.type === 'desktop-client.host-profiles.retry' && commands.at(-1)!.expectedRevision === status.hostProfiles!.revision,
      'Retry uses the current revision after a partially committed operation')
    status.hostProfiles!.ready = true; status.error = null
    await apply(b.id, false)
    await click(button('删除配置')); await click(button('确认删除'))
    status.hostProfiles!.profiles = [a]
    await apply(null, false)
    check(field('sshHostAlias').value === '' && field('profileName').value === '' && field('pairingCode').required &&
      container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
      'Deleting the selected Host creates an empty draft without automatically choosing another Host')
    await input('sshHostAlias', 'new-host')
    await click(button('保存主机配置'))
    check(commands.at(-1)!.type === 'desktop-client.host-profiles.save' && (commands.at(-1) as { id: unknown; name: string }).id === null &&
      (commands.at(-1) as { name: string }).name === 'new-host', 'A new draft saves with its explicit alias as the default display name')
    await act(async () => root.unmount())
    await act(async () => fail(new Error('late profile failure')))
    check(container.childElementCount === 0 && document.querySelector('[role="listbox"]') === null, 'Unmount drops late profile responses and closes the selector')
    return checks
  } finally { await act(async () => root.unmount()); container.remove(); window.piDesktopClient = previous }
}
