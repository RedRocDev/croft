export default {
  server: { host: 'localhost', port: 5173, strictPort: true },
  css: { transformer: 'postcss' },
  esbuild: { jsx: 'automatic' },
  build: { cssMinify: false },
}
