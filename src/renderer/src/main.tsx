import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { TooltipProvider } from './components/TooltipProvider'
import './tokens.css'
import './styles.css'
import './features/chat/chat.css'
import './features/composer/composer.css'
import './features/settings/settings.css'

type RendererErrorBoundaryProps = {
  children: ReactNode
}

type RendererErrorBoundaryState = {
  error: Error | null
}

class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <main className="screen-loading error">
        <div className="kernel-connection-error" role="alert">
          <span>界面渲染失败，请重启 Pi GUI：{this.state.error.message}</span>
        </div>
      </main>
    )
  }
}

document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: light)').matches
  ? 'light'
  : 'dark'

async function bootstrap(): Promise<void> {
  const previewRequested = new URLSearchParams(window.location.search).get('preview') === '1'
  if (
    import.meta.env.MODE === 'development' &&
    previewRequested &&
    typeof window.piGui === 'undefined'
  ) {
    const { createPreviewKernelApi } = await import('./preview/create-preview-kernel-api')
    window.piGui = createPreviewKernelApi()
    document.title = 'Pi GUI — Browser Preview'
  }

  const root = document.getElementById('root')
  if (!root) throw new Error('Renderer root element is missing')

  createRoot(root).render(
    <StrictMode>
      <RendererErrorBoundary>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </RendererErrorBoundary>
    </StrictMode>
  )
}

void bootstrap()
