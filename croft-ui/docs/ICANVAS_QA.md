# iCanvas verification

13 November 2026 · Windows x64 10.0.26300 · Chrome 157.0.8103.78 · Node 24.22.1 · npm 12.2.2. Chrome ran with its sandbox enabled using isolated test profiles and synthetic content. [Feature matrix](ICANVAS_FEATURE_MATRIX.md) · [Architecture](ICANVAS_ARCHITECTURE.md) · [Export evidence](ICANVAS_EXPORT_QA.md)

## Build and tests

- A fresh `npm ci --ignore-scripts` in an isolated directory installed 89 packages from the lockfile. The host supplied Node and a cached copy of npm because `npm` was absent from the default shell path. npm reported zero known vulnerabilities after updating fflate to 0.8.3. [fflate advisory and fix](https://github.com/advisories/GHSA-px8p-9vwx-vf98)
- `npm test` passed 20 tests. Coverage includes inverse camera transforms, bounded cursor-centred zoom, rotated bounds, culling and snapping primitives, global chronological undo/redo with the 50-action cap, atomic compound edits, clone ID remapping, package rejection, visual SVG escaping, and native round trips.
- `npm run build` passed TypeScript and the production Vite bundle. Vite emitted two ignored `use client` directives from the pre-existing Lucide package. The bundle uses local assets and includes third-party notices.

## Sandbox-enabled Chrome walkthrough

| Check | Assertion |
| --- | --- |
| Croft entry and navigation | Home shows Croft and Canvas projects. The utility navigation has exactly Search, Home, Inbox, Settings and Trash. Dialogs close on Escape. Ctrl+K opens Holiday Ideas. The sidebar collapses on canvas entry and restores on exit. |
| Nested canvases and search | Double-click near the centre of the seeded tiles opens Hotels and Paris Hotels. Breadcrumbs navigate back. Ctrl+F jump selects the result. |
| Editing | New Project opens an empty named canvas. Drag, resize, rename, lock/unlock, visibility in Layers, Delete/Undo/Redo and group move/ungroup worked. Explicitly moving a child between a frame and the canvas preserves X/Y and changes the effect of frame collapse. |
| Edges and view | Added a relationship and edited its label. Dots/Lines and minimap controls responded. Geometry tests compare connection endpoints and world coordinates. |
| Project hierarchy | A separate walkthrough moved Hotels to the top level, preserved Paris Hotels and removed the former owned tile. The move picker excluded descendants. A branch trashed from the project menu was restored through Croft Trash and survived reload. An ancestor reference opened the existing project without changing ownership. Deleting its tile left the target intact. |
| Local persistence | Ctrl+S and page reload retained the new project, object and edge. IndexedDB tests exercised transaction rollback, stale write rejection, a ten-snapshot cap, recovery restore, Save As ID remapping and original Blob bytes. A time-accelerated Chrome run exercised the real two-second autosave and five-minute recovery callbacks. Advancing a second five minutes without an edit kept the count unchanged. Ctrl+S cleared temporary recovery with zero explicit versions and the edit survived reload. |
| Import, versions and copies | The production bundle's import dialog rejected synthetic HTML, accepted text, explained why the plain file-input flow could not link, and retained the imported file after reload. Version v1 preview and restore and Save As worked through the UI. |
| Media and placement | Chrome decoded a synthetic PNG and played a PCM WAV and changing VP8 WebM clip before and after reload on the production preview. Smart/Free arrangement, retained MIME types and byte sizes passed. |
| Presentation | A three-stop Chrome run included a SubCanvas. It verified manual next/previous, timed looping, pause and Escape exit with the exact previous camera and route restored. |
| Export | Six formats downloaded from the production preview. Chrome decoded PNG, JPG and SVG. Poppler read an A4 PDF. Native and ZIP packages contained descendant canvases and media. Reimport preserved attachment bytes and generated distinct IDs. |
| Responsive and network | Chrome checked 1440×900 dark, 1024×768 light, 768×850 dark and 390×844 light. The workspace harness passed all 15 checkpoints on both the development server and the production preview on port 4173, including horizontal overflow and top controls. It reported zero page, console or HTTP errors and zero external HTTP requests. |

## Reproduce

Run the following from `croft-ui`. For the browser harnesses, use a local test server, a sandbox-capable Chrome executable and a separately installed Playwright package. Set `CROFT_QA_PLAYWRIGHT` to the package directory and `CROFT_QA_CHROME` to the browser executable. The scripts use fresh browser contexts. The export script optionally takes an installed Poppler `pdfinfo` executable.

```powershell
npm ci
npm test
npm run build
npm run dev
# In another shell with CROFT_QA_PLAYWRIGHT and CROFT_QA_CHROME set:
node tests/icanvas-workspace.mjs
node tests/icanvas-indexeddb.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME
node tests/icanvas-dialogs.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME
node tests/icanvas-media.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME
node tests/icanvas-export.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME 'http://localhost:5173' (Get-Command pdfinfo).Source
```

Set `CROFT_QA_SCREENSHOTS=screenshots` for the workspace run to save light, dark, mobile, nested-canvas, edge and presentation screenshots. The captures from this run are local and ignored by Git.

## Open verification and limitations

- Real filesystem picker grants, relink after file moves, permission across a browser restart, store eviction, out-of-space behavior, abrupt process exit and simultaneous tabs need separate tests. Site data belongs to the current origin and browser profile. Browser-defined storage eviction and background throttling still apply. Simultaneous same-project writes are timestamp-based and can overwrite work.
- Shape and image handling, typography, keyboard-only operation, screen-reader behavior, focus restoration and precise editor/export parity have additional cases beyond the tested fixture. The phone viewport uses a bottom inspector drawer. Dedicated touch pinch remains open.
- Frame reparenting preserves world coordinates. Full recursive frame transforms and equal-gap alignment remain open. Connector rendering uses object endpoints and does not route around other objects.
- Large archives and raster outputs are bounded. The browser test checked one A4 fit and three SVG descendants. It did not certify panoramic readability, multi-page printing, package migrations or 1,000-object responsiveness. [Export limits](ICANVAS_ARCHITECTURE.md)
