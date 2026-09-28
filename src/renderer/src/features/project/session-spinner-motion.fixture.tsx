import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionSpinner } from './ProjectNavigator'
import '../../tokens.css'
import './project.css'

export async function runSessionSpinnerMotionChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
    checks.push(message)
  }
  const render = async (running: boolean): Promise<void> => {
    await act(async () => {
      root.render(<div className="session-action-slot">
        {running ? <SessionSpinner status="running" label="运行中" /> : null}
        <div className="session-row-actions"><button className="icon-button">Action</button></div>
      </div>)
    })
  }
  try {
    await render(false)
    const button = container.querySelector('button')!
    button.focus()
    await render(true)
    const indicator = container.querySelector('.session-lifecycle-indicator')!
    const visual = container.querySelector('.session-spinner-visual')!
    const [animation] = visual.getAnimations()
    check(getComputedStyle(indicator).opacity === '0', 'The focused action slot hides a newly mounted indicator')
    check(animation?.playState === 'paused', 'Phase synchronization does not resume a hidden newly mounted spinner')
    button.blur()
    getComputedStyle(visual).animationPlayState
    check(animation?.playState === 'running', 'Leaving the action slot resumes the spinner')
    button.focus()
    getComputedStyle(visual).animationPlayState
    check(animation?.playState === 'paused', 'Focusing an already mounted spinner pauses it again')
    return checks
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
}
