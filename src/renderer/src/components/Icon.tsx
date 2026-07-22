export type IconName =
  | 'archive'
  | 'arrow-right'
  | 'attach'
  | 'enter'
  | 'folder'
  | 'folder-open'
  | 'left-sidebar-close'
  | 'left-sidebar-open'
  | 'logs'
  | 'plus'
  | 'right-sidebar'
  | 'settings'
  | 'stop'

export function Icon({ name }: { name: IconName }): React.JSX.Element {
  const common = {
    width: 'var(--icon-size-control)',
    height: 'var(--icon-size-control)',
    viewBox: '0 0 24 24',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': true
  }

  switch (name) {
    case 'archive':
      return (
        <svg {...common}>
          <path d="M5.25 8.5h13.5v9.25A2.25 2.25 0 0 1 16.5 20h-9a2.25 2.25 0 0 1-2.25-2.25V8.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M4.75 4h14.5a1 1 0 0 1 1 1v2.5h-16.5V5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M9.25 12h5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
    case 'enter':
      return (
        <svg {...common}>
          <path d="M6.75 5.25v5.5a3 3 0 0 0 3 3h7.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="m13.25 9.75 4 4-4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
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
    case 'logs':
      return (
        <svg {...common}>
          <path d="M6.5 3.75h7.75L18.5 8v10.25A2.25 2.25 0 0 1 16.25 20.5h-9.5A2.25 2.25 0 0 1 4.5 18.25V5.75A2 2 0 0 1 6.5 3.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M14 4.25V8.5h4M8 11h8M8 14.5h8M8 18h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )
    case 'right-sidebar':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M15 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M17.5 9v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.62" />
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
    case 'stop':
      return (
        <svg {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.9" />
        </svg>
      )
  }
}
