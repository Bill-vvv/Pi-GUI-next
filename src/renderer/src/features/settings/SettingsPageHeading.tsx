/**
 * Page title shared by every settings section. `description` carries facts the
 * user needs (for example when a change takes effect); `children` are page-level
 * actions placed on the title row.
 */
export function SettingsPageHeading({
  title,
  description,
  className,
  children
}: {
  title: string
  description?: React.ReactNode
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={[
        'settings-section-heading',
        children === undefined ? null : 'settings-section-heading-with-action',
        className ?? null
      ].filter(Boolean).join(' ')}
    >
      <div className="settings-section-heading-copy">
        <h2>{title}</h2>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {children}
    </div>
  )
}
