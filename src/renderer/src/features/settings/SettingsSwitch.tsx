/**
 * On/off control for immediate-apply settings. A native checkbox with the
 * switch role keeps keyboard, form label and disabled semantics.
 */
export function SettingsSwitch({
  id,
  checked,
  disabled = false,
  label,
  onCheckedChange
}: {
  id: string
  checked: boolean
  disabled?: boolean
  /** Accessible name when no visible `<label htmlFor={id}>` exists. */
  label?: string
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <input
      id={id}
      className="settings-switch"
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  )
}
