import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))

export default {
  server: { host: 'localhost', port: 5173, strictPort: true },
  css: { transformer: 'postcss' },
  esbuild: { jsx: 'automatic' },
  build: { cssMinify: false, rollupOptions: { input: {
    app: resolve(root, 'index.html'),
  } } },
}
