import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from './TooltipProvider'
import '../tokens.css'

export async function runTooltipInteractionChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message)
    checks.push(message)
  }
  const wait = async (milliseconds: number): Promise<void> => {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, milliseconds)) })
  }
  const tooltip = (): Element | null => document.querySelector('[role="tooltip"]')
  try {
    await act(async () => {
      root.render(<TooltipProvider>
        <button data-tooltip="First" aria-describedby="existing"><span>One</span></button>
        <button data-tooltip="Second">Two</button>
      </TooltipProvider>)
    })
    const [first, second] = Array.from(container.querySelectorAll('button')) as [HTMLButtonElement, HTMLButtonElement]
    const over = async (target: Element): Promise<void> => {
      await act(async () => { target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
    }
    const out = async (target: Element): Promise<void> => {
      await act(async () => { target.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })) })
    }
    await over(first)
    check(tooltip() === null, 'First hover waits instead of opening immediately')
    await wait(220)
    await over(first.querySelector('span')!)
    await wait(180)
    check(tooltip()?.textContent === 'First', 'Moving inside the same target does not restart the first-hover delay')
    await Promise.all(tooltip()!.getAnimations().map((animation) => animation.finished))
    check(getComputedStyle(tooltip()!).visibility === 'visible' && Number(getComputedStyle(tooltip()!).opacity) > 0.99,
      `The tooltip is visibly painted after its token-driven fade (${getComputedStyle(tooltip()!).opacity})`)
    check(first.getAttribute('aria-describedby')?.includes(tooltip()!.id), 'Visible tooltip is associated with its trigger')
    await out(first)
    check(tooltip() === null && first.getAttribute('aria-describedby') === 'existing', 'Leaving closes immediately and restores the existing description')
    await over(second)
    check(tooltip()?.textContent === 'Second', 'A nearby tooltip opens immediately during continuous exploration')
    await out(second)
    await wait(850)
    await over(first)
    check(tooltip() === null, 'After the exploration window expires hover waits again')
    await wait(400)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    check(tooltip() === null, 'Escape closes the visible tooltip')
    await over(second)
    check(tooltip() === null, 'Escape resets the skip-delay window')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await wait(400)
    check(tooltip() === null, 'Escape also cancels a pending tooltip without reopening it')
    await act(async () => { first.focus() })
    check(tooltip()?.textContent === 'First', 'Keyboard focus still opens immediately')
    await act(async () => { first.blur() })
    await over(second)
    check(tooltip() === null, 'Keyboard exploration does not warm pointer hover')
    await wait(400)
    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    await over(first)
    check(tooltip() === null, 'Scrolling closes the tooltip and resets continuous exploration')
    await wait(400)
    check(tooltip()?.textContent === 'First', 'The trigger-removal scenario starts with a displayed tooltip')
    await act(async () => {
      root.render(<TooltipProvider><button key="replacement" data-tooltip="Replacement">Replacement</button></TooltipProvider>)
    })
    await wait(0)
    check(tooltip() === null, 'Removing the active trigger closes its tooltip')
    await over(container.querySelector('button')!)
    check(tooltip() === null, 'A removed trigger does not keep pointer exploration warm')
    await act(async () => { root.unmount() })
    await wait(400)
    check(tooltip() === null && first.getAttribute('aria-describedby') === 'existing', 'Unmount cancels pending display and leaves no tooltip or ARIA changes')
    return checks
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
}
