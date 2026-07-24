import { forwardRef, type ButtonHTMLAttributes } from 'react'

import { Icon, type IconName, type IconSize } from './Icon'
import './icon-button.css'

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName
  iconSize?: IconSize
  label: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    iconSize,
    label,
    className,
    title = label,
    type = 'button',
    ...props
  },
  ref
): React.JSX.Element {
  const classes = className === undefined ? 'icon-button' : `icon-button ${className}`

  return (
    <button
      {...props}
      ref={ref}
      className={classes}
      type={type}
      data-tooltip={title}
      aria-label={label}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  )
})
