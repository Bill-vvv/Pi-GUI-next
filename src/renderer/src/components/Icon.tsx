export type IconName =
  | 'archive'
  | 'appearance'
  | 'arrow-left'
  | 'arrow-right'
  | 'attach'
  | 'bolt'
  | 'check'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'collapse-all'
  | 'copy'
  | 'edit'
  | 'enter'
  | 'export'
  | 'extensions'
  | 'folder'
  | 'folder-open'
  | 'fork'
  | 'left-sidebar-close'
  | 'left-sidebar-open'
  | 'right-sidebar-close'
  | 'right-sidebar-open'
  | 'loader'
  | 'messages'
  | 'model'
  | 'packages'
  | 'pin'
  | 'pin-filled'
  | 'plus'
  | 'question'
  | 'undo'
  | 'unread'
  | 'preferences'
  | 'remote'
  | 'settings'
  | 'skills'
  | 'stop'
  | 'subagents'

export type IconSize = 'sm' | 'control' | 'lg'

type IconProps = {
  name: IconName
  size?: IconSize
}

export function Icon({ name, size = 'control' }: IconProps): React.JSX.Element {
  const sizeToken = `var(--icon-size-${size})`
  const common = {
    width: sizeToken,
    height: sizeToken,
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true
  }

  switch (name) {
    case 'appearance':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'archive':
      return (
        <svg {...common}>
          <path d="M5.25 8.5h13.5v9.25A2.25 2.25 0 0 1 16.5 20h-9a2.25 2.25 0 0 1-2.25-2.25V8.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M4.75 4h14.5a1 1 0 0 1 1 1v2.5h-16.5V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M9.25 12h5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'arrow-left':
      return (
        <svg {...common}>
          <path d="M19 12H5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          <path d="m11 6-6 6 6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'arrow-right':
      return (
        <svg {...common}>
          <path d="M5 12h13.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          <path d="m13 6 6 6-6 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'attach':
      return (
        <svg {...common}>
          <path d="M8.25 12.4 13.8 6.85a3.4 3.4 0 0 1 4.8 4.8l-6.9 6.9a5.1 5.1 0 0 1-7.2-7.2l7.05-7.05" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m9.55 15.15 6.1-6.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'bolt':
      return (
        <svg {...common}>
          <path d="m13.5 3-8 10h6l-1 8 8-11h-6l1-7Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="m6.5 9.5 5.5 5 5.5-5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'chevron-left':
      return (
        <svg {...common}>
          <path d="m14.5 6.5-5 5.5 5 5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="m9.5 6.5 5 5.5-5 5.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'close':
      return (
        <svg {...common}>
          <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      )
    case 'collapse-all':
      return (
        <svg {...common}>
          <path d="m7 6.5 5 4.5 5-4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m7 17.5 5-4.5 5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'copy':
      return (
        <svg {...common}>
          <rect x="8" y="8" width="11" height="11" rx="2.25" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 8V6.25A2.25 2.25 0 0 0 13.75 4h-7.5A2.25 2.25 0 0 0 4 6.25v7.5A2.25 2.25 0 0 0 6.25 16H8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'edit':
      return (
        <svg {...common}>
          <path d="M5 19h3.5L18.75 8.75a2.47 2.47 0 0 0-3.5-3.5L5 15.5V19Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m13.75 6.75 3.5 3.5M11.5 19H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'enter':
      return (
        <svg {...common}>
          <path d="M6.75 5.25v5.5a3 3 0 0 0 3 3h7.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m13.25 9.75 4 4-4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'export':
      return (
        <svg {...common}>
          <path d="M12 4v10M8 10l4 4 4-4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 14.5v3A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'extensions':
      return (
        <svg {...common}>
          <rect x="4" y="10" width="6" height="7" rx="1.25" stroke="currentColor" strokeWidth="1.8" />
          <rect x="14" y="4" width="6" height="6" rx="1.25" stroke="currentColor" strokeWidth="1.8" />
          <path d="M7 10V7a3 3 0 0 1 3-3h4M10 13.5h3a4 4 0 0 0 4-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common}>
          <path d="M3.75 7.75A2.75 2.75 0 0 1 6.5 5h3.2c.72 0 1.39.34 1.82.92l.78 1.05c.24.32.61.51 1.01.51h5.19A2.75 2.75 0 0 1 21.25 10.23v5.52A3.25 3.25 0 0 1 18 19H6a3.25 3.25 0 0 1-3.25-3.25v-8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      )
    case 'folder-open':
      return (
        <svg {...common}>
          <path d="M3.75 9V7.75A2.75 2.75 0 0 1 6.5 5h3.2c.72 0 1.39.34 1.82.92l.78 1.05c.24.32.61.51 1.01.51h4.94A2.75 2.75 0 0 1 21 10.23V11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5.2 9.75h14.86a1.5 1.5 0 0 1 1.44 1.92l-1.65 5.58A2.5 2.5 0 0 1 17.45 19H6.1a2.5 2.5 0 0 1-2.4-1.8l-1.14-3.92A2.75 2.75 0 0 1 5.2 9.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      )
    case 'fork':
      return (
        <svg {...common}>
          <circle cx="7" cy="5" r="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="17" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="19" r="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M7 7v2.5A3.5 3.5 0 0 0 10.5 13H12m5-4v.5A3.5 3.5 0 0 1 13.5 13H12v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'left-sidebar-close':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m14.5 9-3 3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" />
        </svg>
      )
    case 'left-sidebar-open':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m12 9 3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" />
        </svg>
      )
    case 'right-sidebar-close':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M15 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m9.5 9 3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" />
        </svg>
      )
    case 'right-sidebar-open':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M15 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="m12 9-3 3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.72" />
        </svg>
      )
    case 'loader':
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      )
    case 'messages':
      return (
        <svg {...common}>
          <path d="M5.25 5.25h13.5A2.25 2.25 0 0 1 21 7.5v7A2.25 2.25 0 0 1 18.75 16.75H10l-4.75 3v-3.3A2.25 2.25 0 0 1 3 14.2V7.5a2.25 2.25 0 0 1 2.25-2.25Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M7.5 9.25h9M7.5 12.75h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'model':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <rect x="4" y="14" width="16" height="6" rx="2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 7h.01M8 17h.01M12 7h5M12 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'packages':
      return (
        <svg {...common}>
          <path d="m4.5 8 7.5-4 7.5 4-7.5 4-7.5-4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M4.5 8v8l7.5 4 7.5-4V8M12 12v8" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      )
    case 'pin':
      return (
        <svg {...common}>
          <path d="M8 4h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M9.25 4.5v5.35c0 1.08-.43 2.12-1.2 2.88L6.5 14.28V16h11v-1.72l-1.55-1.55a4.07 4.07 0 0 1-1.2-2.88V4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 16v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'pin-filled':
      return (
        <svg {...common}>
          <path d="M8 3.1a.9.9 0 0 0 0 1.8h.35v4.95c0 .84-.33 1.64-.92 2.23l-1.56 1.56a.9.9 0 0 0-.27.64V16a.9.9 0 0 0 .9.9h4.6V21a.9.9 0 0 0 1.8 0v-4.1h4.6a.9.9 0 0 0 .9-.9v-1.72a.9.9 0 0 0-.27-.64l-1.56-1.56a3.15 3.15 0 0 1-.92-2.23V4.9H16a.9.9 0 0 0 0-1.8H8Z" fill="currentColor" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )
    case 'question':
      return (
        <svg {...common}>
          <path d="M8.75 8.4a3.45 3.45 0 1 1 5.66 2.65C13.1 12.1 12 12.78 12 14.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 18h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      )
    case 'undo':
      return (
        <svg {...common}>
          <path d="M9 8H5V4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5.5 8.25A7.5 7.5 0 1 1 5 15" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      )
    case 'unread':
      return (
        <svg {...common}>
          <path d="M5 8.25A3.25 3.25 0 0 1 8.25 5h7.5A3.25 3.25 0 0 1 19 8.25v5.5A3.25 3.25 0 0 1 15.75 17h-7.5A3.25 3.25 0 0 1 5 13.75v-5.5Z" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16.75" cy="7.25" r="2.75" fill="currentColor" stroke="var(--color-surface-popover)" strokeWidth="1.5" />
        </svg>
      )
    case 'preferences':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.8" />
          <path d="M6.8 17c.75-2.45 2.5-3.7 5.2-3.7s4.45 1.25 5.2 3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'remote':
      return (
        <svg {...common}>
          <rect x="8" y="3.5" width="8" height="17" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
          <path d="M10.5 6h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="17.25" r="1" fill="currentColor" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <path d="M4.5 7h5.25M13.75 7H19.5M4.5 12h8.25M16.75 12h2.75M4.5 17h2.75M11.25 17h8.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="11.75" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="14.75" cy="12" r="2" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="9.25" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )
    case 'skills':
      return (
        <svg {...common}>
          <path d="M7 4.5h11.5v15H7a3 3 0 0 1 0-6h11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 4.5a3 3 0 0 0-3 3v9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'stop':
      return (
        <svg {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.9" />
        </svg>
      )
    case 'subagents':
      return (
        <svg {...common}>
          <circle cx="12" cy="7" r="3" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="6" cy="17" r="2.5" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="18" cy="17" r="2.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 10v2.5M12 12.5H6v2M12 12.5h6v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
  }
}
