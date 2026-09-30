/**
 * Page title shared by every settings section. `description` carries facts the
 * user needs (for example when a change takes effect); `status` is a live
 * note about changes made on this visit; `children` are page-level actions
 * placed on the title row.
 */
export function SettingsPageHeading({
  title,
  description,
  status,
  className,
  children
}: {
  title: string
  description?: React.ReactNode
  status?: React.ReactNode
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
        {status === undefined || status === null ? null : (
          <p className="settings-section-heading-status" role="status">{status}</p>
        )}
      </div>
      {children}
    </div>
  )
}
