import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      // Pi SDK must stay external. Bundling it rewrites jiti extension aliases to
      // out/main, so package tools/commands such as subagent never register.
      externalizeDepsPlugin({
        include: [
          '@earendil-works/pi-coding-agent',
          '@earendil-works/pi-ai',
          '@earendil-works/pi-agent-core',
          '@earendil-works/pi-tui'
        ]
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'pi-capability-inventory-worker': resolve('src/main/extension/pi-capability-inventory-worker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
