import { useEffect, useRef, useState, type CSSProperties } from 'react'

import type { ThinkingLevel } from '../../../../shared/kernel-contract'
import { localizedThinkingLevelLabel, technicalThinkingLevelLabel } from '../../thinking-level'

type ThinkingLevelSliderProps = {
  levels: readonly ThinkingLevel[]
  value: ThinkingLevel | null
  disabled: boolean
  onCommit: (level: ThinkingLevel) => Promise<void>
}

const ADJUSTMENT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

export function ThinkingLevelSlider({
  levels, value, disabled, onCommit
}: ThinkingLevelSliderProps): React.JSX.Element {
  const [draft, setDraft] = useState<number | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const gestureRef = useRef<'pointer' | 'keyboard' | null>(null)
  const pendingRef = useRef(false)
  const selectedIndex = value === null ? -1 : levels.indexOf(value)
  const index = draft ?? selectedIndex
  const level = levels[index]
  const locked = disabled || pending
  const progress = levels.length < 2 ? 0 : Math.max(0, index) / (levels.length - 1) * 100

  useEffect(() => {
    if (pending) return
    gestureRef.current = null
    setDraft(null)
  }, [value, disabled, pending])

  async function commit(nextIndex: number): Promise<void> {
    gestureRef.current = null
    const next = levels[nextIndex]
    if (locked || pendingRef.current || next === undefined || next === value) {
      if (!pendingRef.current) setDraft(null)
      return
    }
    pendingRef.current = true
    setPending(true)
    setDraft(nextIndex)
    setError(null)
    try {
      await onCommit(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '思考强度设置失败，请重试')
    } finally {
      pendingRef.current = false
      setPending(false)
      setDraft(null)
    }
  }

  return (
    <div className="model-picker-thinking-slider" aria-busy={pending}>
      <div className="model-picker-thinking-value">
        <span>{level === undefined ? value === null ? '未设置' : '当前档位不可用' : technicalThinkingLevelLabel(level)}</span>
        <span className="model-picker-thinking-status" role="status">
          {pending ? '设置中…' : draft !== null ? '松开以应用' : level === undefined ? '' : localizedThinkingLevelLabel(level)}
        </span>
      </div>
      <div
        className="model-picker-thinking-control"
        data-disabled={locked || levels.length < 2}
        data-unset={index < 0}
        style={{ '--thinking-progress': `${progress}%` } as CSSProperties}
      >
        <div className="model-picker-thinking-rail" aria-hidden="true">
          <div className="model-picker-thinking-fill" />
          {levels.map((item, itemIndex) => (
            <span
              key={item}
              className="model-picker-thinking-tick"
              data-active={itemIndex <= index}
              style={{ left: `${levels.length < 2 ? 0 : itemIndex / (levels.length - 1) * 100}%` }}
            />
          ))}
          <span className="model-picker-thinking-thumb" />
        </div>
        <input
          className="model-picker-thinking-input"
          type="range"
          min={0}
          max={Math.max(0, levels.length - 1)}
          step={1}
          value={Math.max(0, index)}
          disabled={locked || levels.length < 2}
          aria-label="思考强度"
          aria-valuetext={level === undefined ? '当前未选择可用档位' : `${technicalThinkingLevelLabel(level)}，${localizedThinkingLevelLabel(level)}`}
          onPointerDown={(event) => {
            if (locked || !event.isPrimary || event.button !== 0) return
            gestureRef.current = 'pointer'
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber
            setDraft(next)
            setError(null)
            // Assistive technology may change a range without a pointer or key gesture.
            if (gestureRef.current === null) void commit(next)
          }}
          onPointerUp={(event) => {
            if (gestureRef.current === 'pointer') void commit(event.currentTarget.valueAsNumber)
          }}
          onLostPointerCapture={() => {
            if (gestureRef.current !== 'pointer') return
            gestureRef.current = null
            setDraft(null)
          }}
          onPointerCancel={() => {
            gestureRef.current = null
            setDraft(null)
          }}
          onKeyDown={(event) => {
            if (ADJUSTMENT_KEYS.has(event.key)) gestureRef.current = 'keyboard'
          }}
          onKeyUp={(event) => {
            if (ADJUSTMENT_KEYS.has(event.key) && gestureRef.current === 'keyboard') {
              void commit(event.currentTarget.valueAsNumber)
            }
          }}
          onBlur={(event) => {
            if (gestureRef.current === 'keyboard') void commit(event.currentTarget.valueAsNumber)
          }}
        />
      </div>
      <div className="model-picker-thinking-labels" aria-hidden="true">
        {levels.map((item, itemIndex) => (
          <span key={item} data-selected={itemIndex === index}>{localizedThinkingLevelLabel(item)}</span>
        ))}
      </div>
      {levels.length === 1 && value !== levels[0] ? (
        <button type="button" disabled={locked} onClick={() => void commit(0)}>
          使用 {technicalThinkingLevelLabel(levels[0]!)}
        </button>
      ) : null}
      {error !== null ? <p className="model-picker-thinking-error" role="alert">{error}</p> : null}
    </div>
  )
}
