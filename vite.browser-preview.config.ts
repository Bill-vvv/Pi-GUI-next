import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true
  }
})
