# iCanvas architecture

13 November 2026. [Decisions and licences](ICANVAS_DECISIONS.md) · [Interface references](ICANVAS_REFERENCES.md) · [Export verification](ICANVAS_EXPORT_QA.md)

## Entry points and local boundary

Croft serves the existing React and TypeScript shell at `http://localhost:5173` using Vite. The server binds to `localhost` and fails if 5173 is already in use. The local server must be running to open or reload the app. Once dependencies and assets are present, the app loads code and media locally. The document's policy allows same-origin resources and localhost development WebSocket connections, and permits Blob and data images for media previews and export. Use the same protocol, hostname, port, and browser profile to reopen the same IndexedDB workspace. Switching to `127.0.0.1` opens a distinct origin. [Vite config](../vite.config.mjs) · [Content Security Policy](../index.html) · [Browser origin rules](https://html.spec.whatwg.org/multipage/browsers.html#concept-origin)

Home, the sidebar's separate project tree, breadcrumbs, and global search open the same `#canvas/<id>` route. The five utility entries remain part of the Croft shell. `App.tsx` owns navigation and sidebar state, `ProjectViews.tsx` owns Home cards, tree rows and project metadata, and `CanvasWorkspace.tsx` coordinates the canvas. On entry Croft collapses the main sidebar, which can still be toggled in the canvas. [Croft shell](../src/App.tsx) · [Project views](../src/features/icanvas/ProjectViews.tsx)

## Scene and editing state

| Layer | Responsibility |
| --- | --- |
| `model.ts` | Project and object UUIDs, project and object parent links, canvas targets, asset references, typed edges, per-project camera and settings, and presentation stops. Names are editable display text. Object flags inherit hidden and locked state from ancestor containers. |
| `geometry.ts` | Conversion between world and screen space, cursor-anchored zoom, rotated bounds, fit, 24-unit grid and connection geometry. Interactive zoom is bounded to 5–800%. |
| `CanvasWorkspace.tsx` | React pointer and keyboard coordination, tool modes, drag/resize/rotate drafts, snapping, marquees, connections, context menus, camera, minimap, playback and export entry. Transient state remains in the mounted workspace. The saved camera and toolbar settings belong to the project. |
| `CanvasVisuals.tsx`, `CanvasInspector.tsx` | DOM media and text, thumbnail previews, Layers, and selected-object properties. Edge and stroke drawing use SVG. Visible media mounts with the scene and its object URLs are revoked on cleanup. |
| `history.ts`, `useCanvasEditing.ts` | Local undo/redo records before/after object and edge snapshots. Multi-object gestures undo as a single action. The history retains up to 50 actions per object and lives in memory. |

The editor builds a per-scene RBush index of rotated visible bounds. A screen-space viewport padded by 100 px is projected into world coordinates for each query. The visible subset is rendered in object order, with active drag drafts included even when they move beyond the original indexed bounds. The index rebuilds when the object array changes. Panning and zooming query the existing index. Large viewport fills can still render many elements at once, and bulk edits rebuild the index on the main thread. The implementation has no established object-count or frame-rate guarantee. [Scene renderer](../src/features/icanvas/CanvasWorkspace.tsx) · [Geometry](../src/features/icanvas/geometry.ts)

## Storage and save semantics

`storage.ts` opens `croft-icanvas`, database version 1, with `projects`, `assets`, `recoveries`, and `versions`. Projects carry stable references to asset records. Imported media is stored as Blobs, and linked media stores validated metadata and an optional browser handle. Versions and recovery snapshots reuse asset IDs rather than copying bytes. IndexedDB write transactions verify rows, hierarchy integrity and referenced assets as needed. A stale version is checked using the persisted modification timestamp. This is a local single-user app and has no automatic cross-tab edit merging. Browser permissions, quotas and eviction still apply. A portable export provides an independent backup. [Storage implementation](../src/features/icanvas/storage.ts) · [IndexedDB specification](https://w3c.github.io/IndexedDB/)

| Operation | Effect |
| --- | --- |
| Autosave | `useCanvasProjects` debounces pending changes by two seconds and serialises writes. `Saved` reflects a completed IndexedDB transaction. A failed write leaves pending work available to retry. |
| Recovery | A five-minute timer checkpoints changed projects in the open app. Retention is ten per project. Recovery is separate from immutable numbered versions. |
| Save | Flushes the pending head and clears recovery entries for the current project after a successful write. |
| Save VC | Creates a numbered local checkpoint of the canvas and its descendants. Restoring a version keeps the pre-restore state as a checkpoint. |
| Save As | Creates a separate local copy with fresh project, object and edge IDs. The selected scope can include the descendant tree. Immutable media IDs can be reused. |
| Export | Downloads a file through the browser. It has no effect on the current head, checkpoints, or local project identity. |

## Media boundary and portable packages

- File-pick and drop paths flow through `ImportDialog.tsx`. Import validates names, size and type markers, rejects known active content, and uses browser decoding for raster images. The picker supports up to 100 MiB for a file and 250 MiB for copied files in a batch. Link In needs a usable permission-bearing handle. Fallback file input supports copying, and unavailable links have a relink action. Media uses local object URLs. Attached files can be downloaded without embedding their document code. [Import](../src/features/icanvas/ImportDialog.tsx) · [Media rendering](../src/features/icanvas/CanvasVisuals.tsx)
- `portability.ts` emits stored ZIP containers with `manifest.json` and numbered `assets/*.bin` entries. The manifest uses `format: "croft-icanvas"` and `version: 1`. The reader allowlists paths and file types, checks local and central ZIP positions and sizes, verifies embedded asset SHA-256 digests, and validates hierarchy and reference consistency before remapping IDs. The module also accepts metadata-only JSON in this schema. The Home picker offers `.croft` and `.zip`. File handles, browser permissions, version/recovery history and out-of-scope canvases are absent from portable packages. Linked attachments can be relinked after import. [Portability](../src/features/icanvas/portability.ts) · [Round-trip verification](ICANVAS_EXPORT_QA.md)
- Editable export is bounded to 120 MiB overall, 8 MiB of manifest and 40 MiB per embedded file. The schema bounds project, object and asset counts. A larger media file can be usable in the active workspace while exceeding the editable export limit. The archive writer works in memory and rejects packages outside these limits. [Portability limits](../src/features/icanvas/portability.ts)
- SVG is generated with escaped text and local, supported raster content. PNG and JPG rasterise that SVG with the browser Canvas API. PDF fits a raster image within one A4 page. Descendant visual exports bundle separate files per canvas, up to 100 canvases. Rendering scales the image down to fit a bound of approximately 4,096 px per side and 12 megapixels. Audio, video and unsupported media are labelled visual placeholders in these static formats. Broad-canvas text fidelity and multi-page tiling remain separate work. [Export implementation](../src/features/icanvas/portability.ts) · [Browser export checks](ICANVAS_EXPORT_QA.md)

## Verification

Run `npm run build` and `node --test tests/*.test.mjs` from `croft-ui`. The IndexedDB, dialog and export tests in `tests/` use an isolated Chrome context. The export fixture verifies file signatures, image decoding, PDF page metadata, and an editable reimport with new IDs and the original attachment bytes. Large-scene performance, storage eviction, browser-specific link permissions, and restore after profile loss require their own evidence. [Export QA commands](ICANVAS_EXPORT_QA.md)
