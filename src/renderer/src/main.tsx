import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './tokens.css'
import './styles.css'
import './features/project/project.css'
import './features/chat/chat.css'
import './features/composer/composer.css'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Renderer root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
