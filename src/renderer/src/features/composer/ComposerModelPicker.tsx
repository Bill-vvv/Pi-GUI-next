import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { KernelState, ThinkingLevel } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import {
  localizedThinkingLevelLabel,
  technicalThinkingLevelLabel,
  THINKING_LEVELS
} from '../../thinking-level'

type ComposerModelPickerProps = {
  model: KernelState['session']['model']
  thinkingLevel: ThinkingLevel | null
  availableModels: NonNullable<KernelState['availableModels']>
  runtimeStatus: KernelState['runtime']['status']
  busy: boolean
  contextKey: string
  openRequestId?: number | null
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

export function ComposerModelPicker({
  model,
  thinkingLevel,
  availableModels,
  runtimeStatus,
  busy,
  contextKey,
  openRequestId = null,
  onSetModel,
  onSetThinkingLevel
}: ComposerModelPickerProps): React.JSX.Element {
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [activeModelKey, setActiveModelKey] = useState<string | null>(null)
  const modelPickerRef = useRef<HTMLDetailsElement>(null)
  const modelMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const modelItemRefs = useRef(new Map<string, HTMLButtonElement>())
  const handledOpenRequestIdRef = useRef<number | null>(null)
  const { popoverRef: modelPickerPopoverRef, position: modelPickerPosition } =
    useViewportPopoverPosition(modelPickerOpen, modelPickerRef, 420, {
      preferredWidth: 380,
      align: 'before'
    })
  const modelPickerPlaced = modelPickerPosition !== null
  const { popoverRef: modelMenuPopoverRef, position: modelMenuPosition } =
    useViewportPopoverPosition(modelMenuOpen, modelMenuTriggerRef, 320, {
      preferredWidth: 240,
      axis: 'horizontal'
    })
  const modelMenuPlaced = modelMenuPosition !== null
  const thinkingLevelMap = model?.thinkingLevelMap ?? {}
  const availableThinkingLevels = model?.reasoning === true
    ? THINKING_LEVELS.filter((level) => isThinkingLevelAvailable(level, thinkingLevelMap))
    : []
  const enabledModelKeys = busy || runtimeStatus !== 'ready'
    ? []
    : availableModels.map((availableModel) => modelKey(availableModel.provider, availableModel.id))
  const selectedModelKey = model === null ? null : modelKey(model.provider, model.id)

  useEffect(() => {
    if (openRequestId === null) {
      handledOpenRequestIdRef.current = null
      setModelPickerOpen(false)
      setModelMenuOpen(false)
      return
    }
    if (handledOpenRequestIdRef.current === openRequestId) return
    handledOpenRequestIdRef.current = openRequestId
    if (runtimeStatus !== 'ready') return
    setModelMenuOpen(false)
    setModelPickerOpen(true)
  }, [openRequestId, runtimeStatus])

  useEffect(() => {
    if (!modelPickerOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      const path = event.composedPath()
      if (
        (modelPickerRef.current !== null && path.includes(modelPickerRef.current)) ||
        (modelPickerPopoverRef.current !== null && path.includes(modelPickerPopoverRef.current)) ||
        (modelMenuPopoverRef.current !== null && path.includes(modelMenuPopoverRef.current))
      ) return
      setModelPickerOpen(false)
      setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [modelPickerOpen])

  useEffect(() => {
    if (!modelPickerOpen || !modelPickerPlaced) return
    const focusFrame = requestAnimationFrame(() => {
      const popover = modelPickerPopoverRef.current
      const preferredTarget =
        popover?.querySelector<HTMLElement>('.model-picker-item.selected:not(:disabled)') ??
        popover?.querySelector<HTMLElement>('.model-picker-model-button')
      preferredTarget?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [modelPickerOpen, modelPickerPlaced])

  useEffect(() => {
    if (!modelPickerOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (modelMenuOpen) {
        setModelMenuOpen(false)
        requestAnimationFrame(() => modelMenuTriggerRef.current?.focus())
        return
      }
      closeModelPickerAndRestoreFocus()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [modelMenuOpen, modelPickerOpen])

  useEffect(() => {
    if (!modelMenuOpen || !modelMenuPlaced || activeModelKey === null) return
    const focusFrame = requestAnimationFrame(() => {
      modelItemRefs.current.get(activeModelKey)?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [activeModelKey, modelMenuOpen, modelMenuPlaced])

  useEffect(() => {
    if (runtimeStatus === 'ready' || runtimeStatus === 'running') return
    setModelPickerOpen(false)
    setModelMenuOpen(false)
  }, [runtimeStatus])

  useEffect(() => {
    setModelPickerOpen(false)
    setModelMenuOpen(false)
  }, [contextKey])

  function openModelMenu(preference: 'selected-or-first' | 'last' = 'selected-or-first'): void {
    const nextKey = preference === 'last'
      ? enabledModelKeys.at(-1) ?? null
      : selectedModelKey !== null && enabledModelKeys.includes(selectedModelKey)
        ? selectedModelKey
        : enabledModelKeys[0] ?? null
    setActiveModelKey(nextKey)
    setModelMenuOpen(true)
  }

  function focusModelAt(key: string): void {
    setActiveModelKey(key)
    requestAnimationFrame(() => modelItemRefs.current.get(key)?.focus())
  }

  function moveModelFocus(direction: 1 | -1): void {
    if (enabledModelKeys.length === 0) return
    const currentIndex = activeModelKey === null ? -1 : enabledModelKeys.indexOf(activeModelKey)
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : enabledModelKeys.length - 1
      : (currentIndex + direction + enabledModelKeys.length) % enabledModelKeys.length
    const nextKey = enabledModelKeys[nextIndex]
    if (nextKey !== undefined) focusModelAt(nextKey)
  }

  function closeModelPickerAndContinueTab(backward: boolean): void {
    const picker = modelPickerRef.current
    const summary = picker?.querySelector<HTMLElement>('summary') ?? null
    const target = summary === null
      ? null
      : findAdjacentTabTarget(
          summary,
          [picker, modelPickerPopoverRef.current, modelMenuPopoverRef.current],
          backward
        )
    setModelMenuOpen(false)
    setModelPickerOpen(false)
    requestAnimationFrame(() => {
      if (target !== null && target.isConnected) target.focus()
    })
  }

  function closeModelPickerAndRestoreFocus(): void {
    setModelPickerOpen(false)
    setModelMenuOpen(false)
    requestAnimationFrame(() => {
      modelPickerRef.current?.querySelector<HTMLElement>('summary')?.focus()
    })
  }

  return (
    <details
      ref={modelPickerRef}
      className="composer-model-controls"
      open={modelPickerOpen}
    >
      <summary
        className="model-picker-button"
        aria-label="选择模型和思考强度"
        aria-haspopup="dialog"
        aria-expanded={modelPickerOpen}
        aria-controls={modelPickerOpen ? 'model-picker-popover' : undefined}
        onClick={(event) => {
          // Fully control open state in React. Native <details> toggle races with
          // portaled menus and can drop model selection clicks.
          event.preventDefault()
          setModelPickerOpen((open) => {
            if (open) setModelMenuOpen(false)
            return !open
          })
        }}
      >
        <span className="model-summary-label">
          {model?.name ?? model?.id ?? '选择模型'}
        </span>
        {thinkingLevel !== null ? (
          <span className="model-summary-meta">
            {technicalThinkingLevelLabel(thinkingLevel)}
          </span>
        ) : null}
      </summary>
      {modelPickerOpen && modelPickerPosition !== null
        ? createPortal(
            <div
              ref={modelPickerPopoverRef}
              id="model-picker-popover"
              className="model-picker-popover"
              role="dialog"
              aria-label="模型和思考强度设置"
              data-placement={modelPickerPosition.placement}
              style={modelPickerPosition.style}
            >
              <div className="model-picker-content">
                <section className="model-picker-thinking-section" aria-label="思考强度">
                  <h3 className="model-picker-section-heading">思考强度</h3>
                  {model === null ? (
                    <p className="model-picker-empty" role="status">请先选择模型</p>
                  ) : model.reasoning === false ? (
                    <p className="model-picker-empty" role="status">
                      当前模型不支持思考强度
                    </p>
                  ) : availableThinkingLevels.length === 0 ? (
                    <p className="model-picker-empty" role="status">
                      当前模型没有可用的思考强度
                    </p>
                  ) : (
                    <div className="model-picker-thinking-list">
                      {availableThinkingLevels.map((level) => {
                        const selected = thinkingLevel === level
                        return (
                          <button
                            className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                            type="button"
                            key={level}
                            aria-pressed={selected}
                            disabled={busy || runtimeStatus !== 'ready'}
                            onClick={() => {
                              closeModelPickerAndRestoreFocus()
                              void onSetThinkingLevel(level).catch(() => undefined)
                            }}
                          >
                            <span className="model-picker-option-copy">
                              <span className="model-picker-option-label">
                                {technicalThinkingLevelLabel(level)}
                              </span>
                              <span className="model-picker-option-meta">
                                {localizedThinkingLevelLabel(level)}
                              </span>
                            </span>
                            {selected
                              ? <span className="model-picker-selected">当前</span>
                              : null}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </section>

                <div className="model-picker-model-menu">
                  <button
                    ref={modelMenuTriggerRef}
                    className="model-picker-model-button"
                    type="button"
                    aria-label="选择其他模型"
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
                    aria-controls={modelMenuOpen ? 'model-picker-model-popover' : undefined}
                    data-placement={modelMenuPosition?.placement ?? 'right'}
                    onClick={() => {
                      if (modelMenuOpen) setModelMenuOpen(false)
                      else openModelMenu()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Tab' && modelMenuOpen) {
                        event.preventDefault()
                        event.stopPropagation()
                        closeModelPickerAndContinueTab(event.shiftKey)
                        return
                      }
                      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                      event.preventDefault()
                      openModelMenu(event.key === 'ArrowUp' ? 'last' : 'selected-or-first')
                    }}
                  >
                    <span className="model-picker-option-copy">
                      <span className="model-picker-heading-label">模型</span>
                      <span className="model-picker-option-label">
                        {model?.name ?? model?.id ?? '选择模型'}
                      </span>
                    </span>
                    <Icon name="arrow-right" size="sm" />
                  </button>
                  {modelMenuOpen && modelMenuPosition !== null
                    ? createPortal(
                        <div
                          ref={modelMenuPopoverRef}
                          id="model-picker-model-popover"
                          className="model-picker-model-popover"
                          role="menu"
                          aria-label="选择模型"
                          data-placement={modelMenuPosition.placement}
                          style={modelMenuPosition.style}
                          onKeyDown={(event) => {
                            if (event.key === 'Tab') {
                              event.preventDefault()
                              event.stopPropagation()
                              closeModelPickerAndContinueTab(event.shiftKey)
                              return
                            }
                            if (event.key === 'ArrowDown') {
                              event.preventDefault()
                              moveModelFocus(1)
                              return
                            }
                            if (event.key === 'ArrowUp') {
                              event.preventDefault()
                              moveModelFocus(-1)
                              return
                            }
                            if (event.key === 'Home') {
                              event.preventDefault()
                              const firstKey = enabledModelKeys[0]
                              if (firstKey !== undefined) focusModelAt(firstKey)
                              return
                            }
                            if (event.key === 'End') {
                              event.preventDefault()
                              const lastKey = enabledModelKeys.at(-1)
                              if (lastKey !== undefined) focusModelAt(lastKey)
                            }
                          }}
                        >
                          {availableModels.length > 0 ? (
                            <div className="model-picker-model-list">
                              {availableModels.map((availableModel) => {
                                const key = modelKey(availableModel.provider, availableModel.id)
                                const selected =
                                  model?.provider === availableModel.provider &&
                                  model.id === availableModel.id
                                const disabled = busy || runtimeStatus !== 'ready'
                                return (
                                  <button
                                    ref={(element) => {
                                      if (element === null) modelItemRefs.current.delete(key)
                                      else modelItemRefs.current.set(key, element)
                                    }}
                                    className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                                    type="button"
                                    role="menuitemradio"
                                    key={key}
                                    aria-checked={selected}
                                    tabIndex={!disabled && activeModelKey === key ? 0 : -1}
                                    disabled={disabled}
                                    onFocus={() => setActiveModelKey(key)}
                                    onPointerEnter={() => {
                                      if (!disabled) setActiveModelKey(key)
                                    }}
                                    onClick={() => {
                                      closeModelPickerAndRestoreFocus()
                                      if (!selected) {
                                        void onSetModel(
                                          availableModel.provider,
                                          availableModel.id
                                        ).catch(() => undefined)
                                      }
                                    }}
                                  >
                                    <span className="model-picker-option-copy">
                                      <span className="model-picker-option-label">
                                        {availableModel.name.trim() || availableModel.id}
                                      </span>
                                      <span className="model-picker-option-meta">
                                        {availableModel.provider}/{availableModel.id}
                                      </span>
                                    </span>
                                    {selected
                                      ? <span className="model-picker-selected">当前</span>
                                      : null}
                                  </button>
                                )
                              })}
                            </div>
                          ) : (
                            <p className="model-picker-empty" role="status">暂无可用模型</p>
                          )}
                        </div>,
                        document.body
                      )
                    : null}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </details>
  )
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`
}

function findAdjacentTabTarget(
  origin: HTMLElement,
  excludedRoots: Array<HTMLElement | null>,
  backward: boolean
): HTMLElement | null {
  const tabbable = Array.from(document.querySelectorAll<HTMLElement>([
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[contenteditable="true"]',
    '[tabindex]'
  ].join(','))).filter(isTabbable)
  const originIndex = tabbable.indexOf(origin)
  if (originIndex < 0 || tabbable.length < 2) return null
  const direction = backward ? -1 : 1
  for (let offset = 1; offset < tabbable.length; offset += 1) {
    const index = (originIndex + direction * offset + tabbable.length) % tabbable.length
    const candidate = tabbable[index]
    if (candidate !== undefined && !excludedRoots.some((root) => root?.contains(candidate) === true)) {
      return candidate
    }
  }
  return null
}

function isTabbable(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled')) return false
  if (element.closest('[inert], [aria-hidden="true"]') !== null) return false
  return element.getClientRects().length > 0
}

function isThinkingLevelAvailable(
  level: ThinkingLevel,
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>
): boolean {
  const mappedLevel = thinkingLevelMap[level]
  if (mappedLevel === null) return false
  if (level === 'xhigh' || level === 'max') return mappedLevel !== undefined
  return true
}
