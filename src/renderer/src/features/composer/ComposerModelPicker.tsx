import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { KernelState, ThinkingLevel } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'

const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

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
  const modelPickerRef = useRef<HTMLDetailsElement>(null)
  const modelMenuTriggerRef = useRef<HTMLButtonElement>(null)
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
    if (!modelMenuOpen || !modelMenuPlaced) return
    const focusFrame = requestAnimationFrame(() => {
      const popover = modelMenuPopoverRef.current
      const preferredTarget =
        popover?.querySelector<HTMLElement>('.model-picker-item.selected:not(:disabled)') ??
        popover?.querySelector<HTMLElement>('.model-picker-item:not(:disabled)')
      preferredTarget?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [modelMenuOpen, modelMenuPlaced])

  useEffect(() => {
    if (runtimeStatus === 'ready' || runtimeStatus === 'running') return
    setModelPickerOpen(false)
    setModelMenuOpen(false)
  }, [runtimeStatus])

  useEffect(() => {
    setModelPickerOpen(false)
    setModelMenuOpen(false)
  }, [contextKey])

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
            {thinkingOptionLabel(thinkingLevel)}
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
                                {thinkingOptionLabel(level)}
                              </span>
                              <span className="model-picker-option-meta">
                                {thinkingLabel(level)}
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
                    onClick={() => setModelMenuOpen((open) => !open)}
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
                        >
                          {availableModels.length > 0 ? (
                            <div className="model-picker-model-list">
                              {availableModels.map((availableModel) => {
                                const selected =
                                  model?.provider === availableModel.provider &&
                                  model.id === availableModel.id
                                return (
                                  <button
                                    className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                                    type="button"
                                    role="menuitemradio"
                                    key={`${availableModel.provider}:${availableModel.id}`}
                                    aria-checked={selected}
                                    disabled={busy || runtimeStatus !== 'ready'}
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

function thinkingLabel(level: ThinkingLevel): string {
  return {
    off: '关闭',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高'
  }[level]
}

function thinkingOptionLabel(level: ThinkingLevel): string {
  return {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max'
  }[level]
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
