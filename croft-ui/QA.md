# Croft UI verification

13 November 2026. Tests ran on Windows x64 with Node 24.22.1, npm 12.2.2, Vite 7.3.8, Playwright 1.62.1 and installed Chrome 157.0.8103.78. Chrome ran headless with its browser sandbox enabled.

## Build

- `npm ci --ignore-scripts` passed from `package-lock.json` and installed 85 packages. Vite used the official Rollup and esbuild WebAssembly packages. The installed project dependency tree contained no `.node` or `.exe` files.
- `npm run build` passed TypeScript checking and produced the browser bundle in `dist/`. Vite reported 2,097 transformed modules and emitted the original logo, display mark and cover. The original logo SHA-256 matched the research manifest, `29b06bfe13e8af6687fa9c8493cca9c709ed9f54882955564a3b45e71145030d`.
- Rollup reported two ignored `use client` directives in the Lucide dependency. The build exited successfully.

## Browser checks

- `http://localhost:5173/` returned HTTP 200 in Chrome and PowerShell. Chrome rendered the title `Croft — Space to grow.` and the Fieldwork Studio heading.
- At 1440 × 900, verified workspace navigation, nested page collapse/expand, weekly and meeting notes, the document formatting preview, slash command filtering and Escape, and keyboard workspace search that opened Projects.
- Verified Table, Board, Calendar, Gallery and List activation, record side peek and close, status filtering, name sorting and in-table search.
- Verified appearance picker, light-to-dark preference change, and the empty Trash dialog.
- At 1024 × 768 and 768 × 850, Home fit the viewport without horizontal page overflow. At 768 px, the sidebar opened from its button and closed after page navigation.
- Chrome recorded zero page errors, error console messages, unsuccessful HTTP responses or external HTTP requests during these scenarios. Local image decode passed for the captured screens.

The screenshot directory records the desktop views, overlays and narrow-viewport checks. This was browser prototype QA with sample content and UI state. Native runtime, storage and Windows installer verification remain outside this pass.
