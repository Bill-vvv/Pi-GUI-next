/**
 * Inline choice for two or three short, immediate-apply options. Follows the
 * settings page's existing pressed-button group (theme cubes, density tiles);
 * longer or open-ended option lists stay in `Select`.
 */
export function SettingsSegmented<Value extends string>({
  labelledBy,
  value,
  options,
  disabled = false,
  onValueChange
}: {
  /** Id of the row label that names the group. */
  labelledBy: string
  value: Value
  options: ReadonlyArray<{ value: Value; label: string }>
  disabled?: boolean
  onValueChange: (value: Value) => void
}): React.JSX.Element {
  return (
    <div className="settings-segmented" role="group" aria-labelledby={labelledBy}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => {
            if (option.value !== value) onValueChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
