import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from './Icon'
import { useViewportPopoverPosition } from './useViewportPopoverPosition'
import './selection-control.css'
import './font-select.css'

type FontSelectProps = {
  id: string
  family: string | null
  systemFonts: readonly string[]
  defaultLabel: string
  previewKind: 'ui' | 'code'
  disabled?: boolean
  onValueChange: (family: string | null) => void
}

type FontCandidate = {
  key: string
  family: string | null
  label: string
  disabled?: boolean
}

const DEFAULT_KEY = 'default'

export function FontSelect({
  id,
  family,
  systemFonts,
  defaultLabel,
  previewKind,
  disabled = false,
  onValueChange
}: FontSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const { popoverRef, position } = useViewportPopoverPosition(open, triggerRef, 390)
  const generatedId = useId()
  const listboxId = `${id}-${generatedId}-listbox`
  const selectedFontAvailable = family === null || systemFonts.includes(family)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const candidates = useMemo<FontCandidate[]>(() => {
    const installedFonts = systemFonts
      .filter((font) => font.toLocaleLowerCase().includes(normalizedQuery))
      .map((font) => ({ key: `font:${font}`, family: font, label: font }))

    return [
      { key: DEFAULT_KEY, family: null, label: defaultLabel },
      ...(!selectedFontAvailable && family !== null
        ? [{
            key: `font:${family}`,
            family,
            label: `${family}（当前不可用）`,
            disabled: true
          }]
        : []),
      ...installedFonts
    ]
  }, [defaultLabel, family, normalizedQuery, selectedFontAvailable, systemFonts])
  const enabledCandidates = candidates.filter((candidate) => !candidate.disabled)
  const activeCandidate = candidates.find((candidate) => candidate.key === activeKey) ?? null
  const hasMatchingInstalledFont = systemFonts.some(
    (font) => font.toLocaleLowerCase().includes(normalizedQuery)
  )
  const selectedLabel = family === null
    ? defaultLabel
    : selectedFontAvailable ? family : `${family}（当前不可用）`

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        target instanceof Node &&
        !rootRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [open])

  useEffect(() => {
    if (!open || activeKey === null) return
    optionRefs.current.get(activeKey)?.scrollIntoView({ block: 'nearest' })
  }, [activeKey, open])

  function showMenu(preferLast = false): void {
    setQuery('')
    const selectedKey = family === null ? DEFAULT_KEY : `font:${family}`
    setActiveKey(
      (selectedFontAvailable ? selectedKey : undefined) ??
      (preferLast ? enabledCandidates.at(-1)?.key : enabledCandidates[0]?.key) ??
      null
    )
    setOpen(true)
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function moveActive(direction: 1 | -1): void {
    if (enabledCandidates.length === 0) return
    const currentIndex = enabledCandidates.findIndex((candidate) => candidate.key === activeKey)
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : enabledCandidates.length - 1
      : (currentIndex + direction + enabledCandidates.length) % enabledCandidates.length
    setActiveKey(enabledCandidates[nextIndex].key)
  }

  function selectCandidate(candidate: FontCandidate): void {
    if (candidate.disabled) return
    closeMenu(true)
    if (candidate.family !== family) onValueChange(candidate.family)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) showMenu(event.key === 'ArrowUp')
      else moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }

    if (open && event.key === 'Enter' && activeCandidate !== null) {
      event.preventDefault()
      selectCandidate(activeCandidate)
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeMenu(true)
      return
    }

    if (event.key === 'Tab') setOpen(false)
  }

  const previewStyle = activeCandidate === null
    ? undefined
    : {
        fontFamily: activeCandidate.family === null
          ? `var(--font-${previewKind}-system)`
          : `${quoteFontFamily(activeCandidate.family)}, var(--font-${previewKind}-system)`
      }

  return (
    <div ref={rootRef} className="font-select" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        id={id}
        className="font-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) closeMenu()
          else showMenu()
        }}
      >
        <span className="font-select-value">{selectedLabel}</span>
        <span className="font-select-chevron" aria-hidden="true">
          <Icon name="chevron-down" size="sm" />
        </span>
      </button>

      {open && position !== null ? createPortal(
        <div
          ref={popoverRef}
          className="font-select-popover"
          data-placement={position.placement}
          style={position.style}
        >
          <input
            ref={searchRef}
            className="font-select-search"
            type="search"
            placeholder="搜索字体"
            aria-label="搜索字体"
            aria-controls={listboxId}
            aria-activedescendant={activeCandidate === null
              ? undefined
              : `${listboxId}-option-${candidates.indexOf(activeCandidate)}`}
            value={query}
            onChange={(event) => {
              const nextQuery = event.currentTarget.value
              const normalizedNextQuery = nextQuery.trim().toLocaleLowerCase()
              const firstMatchingFont = systemFonts.find(
                (font) => font.toLocaleLowerCase().includes(normalizedNextQuery)
              )
              setQuery(nextQuery)
              setActiveKey(firstMatchingFont === undefined ? DEFAULT_KEY : `font:${firstMatchingFont}`)
            }}
          />

          {activeCandidate === null ? null : (
            <div className="font-select-preview" style={previewStyle} aria-live="polite">
              {previewKind === 'ui'
                ? 'Pi Workbench 字体预览　你好，Aa 123'
                : 'const message = "你好，Pi"; // Aa 123'}
            </div>
          )}

          <div id={listboxId} className="font-select-list" role="listbox">
            {candidates.map((candidate, index) => {
              const selected = candidate.family === family
              const active = candidate.key === activeKey

              return (
                <button
                  ref={(node) => {
                    if (node === null) optionRefs.current.delete(candidate.key)
                    else optionRefs.current.set(candidate.key, node)
                  }}
                  id={`${listboxId}-option-${index}`}
                  className="font-select-option"
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-active={active || undefined}
                  disabled={candidate.disabled}
                  tabIndex={-1}
                  key={candidate.key}
                  onPointerMove={() => {
                    if (!candidate.disabled) setActiveKey(candidate.key)
                  }}
                  onClick={() => selectCandidate(candidate)}
                >
                  <span>{candidate.label}</span>
                  <span className="font-select-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                </button>
              )
            })}
            {!hasMatchingInstalledFont && normalizedQuery !== '' ? (
              <p className="font-select-empty" role="status">没有匹配的字体</p>
            ) : null}
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  )
}

function quoteFontFamily(family: string): string {
  return `"${family
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, ' ')}"`
}
