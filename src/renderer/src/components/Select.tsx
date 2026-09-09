import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from './Icon'
import { useViewportPopoverPosition } from './useViewportPopoverPosition'
import './selection-control.css'
import './select.css'

export type SelectOptionDetailTone = 'default' | 'active' | 'attention' | 'error'

export type SelectOption = {
  value: string
  label: string
  detail?: string
  detailTone?: SelectOptionDetailTone
  disabled?: boolean
}

export type SelectOptionGroup = {
  label?: string
  options: readonly SelectOption[]
}

type SelectProps = {
  id: string
  value: string
  groups: readonly SelectOptionGroup[]
  disabled?: boolean
  onValueChange: (value: string) => void
}

export function Select({
  id,
  value,
  groups,
  disabled = false,
  onValueChange
}: SelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeValue, setActiveValue] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const { popoverRef, position } = useViewportPopoverPosition(open, triggerRef, 320)
  const listboxId = `${id}-${useId()}-listbox`
  const options = groups.flatMap((group) => group.options)
  const enabledOptions = options.filter((option) => !option.disabled)
  const selectedOption = options.find((option) => option.value === value) ?? null

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
    if (!open || activeValue === null) return
    optionRefs.current.get(activeValue)?.focus()
  }, [activeValue, open])

  function showMenu(preferLast = false): void {
    const selectedEnabled = enabledOptions.find((option) => option.value === value)
    setActiveValue(
      selectedEnabled?.value ??
      (preferLast ? enabledOptions.at(-1)?.value : enabledOptions[0]?.value) ??
      null
    )
    setOpen(true)
  }

  function closeMenu(restoreFocus = false): void {
    setOpen(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  function moveActive(direction: 1 | -1): void {
    if (enabledOptions.length === 0) return
    const currentIndex = enabledOptions.findIndex((option) => option.value === activeValue)
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : enabledOptions.length - 1
      : (currentIndex + direction + enabledOptions.length) % enabledOptions.length
    setActiveValue(enabledOptions[nextIndex].value)
  }

  function selectValue(nextValue: string): void {
    closeMenu(true)
    if (nextValue !== value) onValueChange(nextValue)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) showMenu(event.key === 'ArrowUp')
      else moveActive(event.key === 'ArrowDown' ? 1 : -1)
      return
    }

    if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      setActiveValue(
        (event.key === 'Home' ? enabledOptions[0] : enabledOptions.at(-1))?.value ?? null
      )
      return
    }

    if (open && (event.key === 'Enter' || event.key === ' ') && activeValue !== null) {
      event.preventDefault()
      selectValue(activeValue)
      return
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeMenu(true)
      return
    }

    if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div
      ref={rootRef}
      className="select-control"
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        id={id}
        className="select-control-trigger"
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
        <span className="select-control-value">
          <span className="select-control-value-label">
            {selectedOption?.label ?? '请选择'}
          </span>
          {selectedOption?.detail === undefined ? null : (
            <span
              className="select-control-value-detail"
              data-tone={selectedOption.detailTone ?? 'default'}
            >
              {selectedOption.detail}
            </span>
          )}
        </span>
        <span className="select-control-chevron" aria-hidden="true">
          <Icon name="chevron-down" size="sm" />
        </span>
      </button>

      {open && position !== null ? createPortal(
        <div
          ref={popoverRef}
          id={listboxId}
          className="select-control-popover"
          role="listbox"
          data-placement={position.placement}
          style={position.style}
        >
          {groups.map((group, groupIndex) => (
            <div
              className="select-control-group"
              role="group"
              aria-label={group.label}
              key={group.label ?? `group-${groupIndex}`}
            >
              {group.label === undefined ? null : (
                <div className="select-control-group-label">{group.label}</div>
              )}
              {group.options.map((option) => {
                const selected = option.value === value
                const active = option.value === activeValue

                return (
                  <button
                    ref={(node) => {
                      if (node === null) optionRefs.current.delete(option.value)
                      else optionRefs.current.set(option.value, node)
                    }}
                    className="select-control-option"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={active || undefined}
                    disabled={option.disabled}
                    tabIndex={-1}
                    key={option.value}
                    onPointerMove={() => {
                      if (!option.disabled) setActiveValue(option.value)
                    }}
                    onClick={() => selectValue(option.value)}
                  >
                    <span className="select-control-option-content">
                      <span className="select-control-option-label">{option.label}</span>
                      {option.detail === undefined ? null : (
                        <span
                          className="select-control-option-detail"
                          data-tone={option.detailTone ?? 'default'}
                        >
                          {option.detail}
                        </span>
                      )}
                    </span>
                    <span className="select-control-check" aria-hidden="true">
                      {selected ? <Icon name="check" size="sm" /> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>,
        document.body
      ) : null}
    </div>
  )
}
