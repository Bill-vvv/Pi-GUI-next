import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/remote'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve('out/remote'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve('src/remote/index.html')
    }
  },
  server: {
    host: 'localhost',
    strictPort: true
  }
})
