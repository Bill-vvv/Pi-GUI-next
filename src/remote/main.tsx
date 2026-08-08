import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '../renderer/src/components/TooltipProvider.tsx'
import { configureRendererHost } from '../renderer/src/host.ts'
import { normalizeExternalUrl } from '../shared/external-url.ts'
import '../renderer/src/tokens.css'
import '../renderer/src/styles.css'
import '../renderer/src/composition/workbench.css'
import '../renderer/src/features/chat/chat.css'
import '../renderer/src/features/composer/composer.css'
import './remote.css'
import { createRemoteImageLoaders, RemoteApp } from './RemoteApp.tsx'
import { openRemoteExternal } from './remote-external.ts'
import { RemoteClient } from './transport.ts'

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
          <span>远程界面渲染失败：{this.state.error.message}</span>
        </div>
      </main>
    )
  }
}

document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: light)').matches
  ? 'light'
  : 'dark'

const client = new RemoteClient()
const imageLoaders = createRemoteImageLoaders(client)

configureRendererHost({
  normalizeOpenTarget: normalizeExternalUrl,
  openExternal: openRemoteExternal,
  getMessageImage: imageLoaders.getMessageImage,
  getToolImage: imageLoaders.getToolImage
})

const root = document.getElementById('root')
if (!root) throw new Error('Remote root element is missing')

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <TooltipProvider>
        <RemoteApp client={client} />
      </TooltipProvider>
    </RendererErrorBoundary>
  </StrictMode>
)
