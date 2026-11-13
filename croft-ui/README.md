# Croft — Space to grow.

Croft is a localhost UI prototype for a design studio workspace. It includes Home, the studio handbook and its nested pages, a Projects database preview with Table, Board, Calendar, Gallery and List layouts, workspace Search, and Settings with light, dark and system appearances.

## Run locally

Use Node.js 22.12 or newer with npm. From the repository root:

```sh
cd croft-ui
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite binds to localhost and uses port 5173. After dependencies are installed, the workspace uses only local files and the local development server.

```sh
npm run check
npm run build
npm run preview
```

The production build goes to `dist/`. The project uses the published WebAssembly variants of the Vite 7 build tools so dependency installation and bundling can run on Windows hosts that restrict native Node add-ons.

## Explore

- Use the sidebar to open the handbook and expand its nested pages.
- In the handbook, click the sample sentence “Write down what changed and why.” for the formatting toolbar, or press `/` for the slash menu. The page options menu also opens both previews.
- Open Projects to switch views and preview records. Calendar navigation, filters, sorting and query previews use the same in-memory sample data.
- Press `Ctrl+K` to open workspace Search. Use Settings → Preferences → Appearance for light, dark and system views.

Page content, settings examples, sharing, and templates are mock states. The prototype has no backend, storage, sign-in, real document editing, or synchronization. Theme and other preview selections reset when the page reloads.

See [Mobbin references](REFERENCES.md) and [screenshots](screenshots/). Croft uses the unchanged original C logo and its padded display derivative. The cover is original generated workspace artwork, bundled locally.
