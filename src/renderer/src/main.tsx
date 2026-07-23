import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './tokens.css'
import './styles.css'
import './features/chat/chat.css'
import './features/composer/composer.css'
import './features/settings/settings.css'

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
      <App />
    </StrictMode>
  )
}

void bootstrap()
