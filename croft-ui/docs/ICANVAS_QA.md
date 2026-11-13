# iCanvas verification

13 November 2026 · Windows x64 10.0.26300 · Chrome 157.0.8103.78 · Node 24.22.1 · npm 12.2.2. Chrome ran with its sandbox enabled using isolated test profiles and synthetic content. [Feature matrix](ICANVAS_FEATURE_MATRIX.md) · [Architecture](ICANVAS_ARCHITECTURE.md) · [Export evidence](ICANVAS_EXPORT_QA.md)

## Image tools

| Check | Evidence |
| --- | --- |
| Crop, tone, Looks and effects | Chrome exercised fixed-ratio portrait crop on a rotated image card inside a frame, Cancel, handles, typed angle, the five tone controls, a source Look and intensity, circular framing, outline, shadow, Compare Original and Reset. It checked stable outer geometry, a single undo for a multi-step slider drag, and slider values after redo. [Image tools](../tests/icanvas-image-tools.mjs) |
| Face, stack and palette | A card used the same PNG on both faces, alongside a separate image instance. Edit settings stayed independent through flip, reload, move through stack order, Fan Out, Restack and Unstack All. The sampler gave feedback for a transparent pixel. A sampled swatch was added, renamed, removed and restored with Undo. Chrome applied it to text, card fill, drawing, connector, outline and shadow. [Image tools](../tests/icanvas-image-tools.mjs) |
| Save failure, versions and copies | An injected `QuotaExceededError` kept a changed Back brightness visible, displayed Save failed and preserved the committed brightness until Retry succeeded. Chrome restored edits and swatches with Save VC, restored an image edit from a recovery copy, and verified that changing the Save As copy left the original untouched. A second tab could neither open editing controls nor save changed edits and swatches directly. [Image tools](../tests/icanvas-image-tools.mjs) |
| Renderer and performance | A synthetic chart checked alpha, mask shape and positioning, warmth, crop, a JPEG with EXIF orientation 6, and effect pixels outside the image frame. Two headless Windows Chrome runs at 2× device scale used a 4,096×3,072 source with a 768 px preview cap. First paints took 139–182 ms and subsequent adjustment paints took 14–28 ms. Browser decoding can allocate the full source. A separate 1440×950 run with 260 compact cards and edits on all 520 faces mounted one edited canvas and three silhouettes. The new face was visible within 125 ms of a keyboard flip in that run, including automation overhead. All cards in that fixture shared a 1,536×1,024 synthetic PNG. [Renderer](../tests/icanvas-image-rendering.mjs) · [Stack regression](../tests/icanvas-stacks.mjs) |
| Linked source and file safety | Real Chrome file drag handles and a filesystem rename verified missing access and reattachment. A full restart returned a permission prompt. Denial was injected. A different-size synthetic file presented through a real replacement handle prompted for crop reapplication. The source files retained their SHA-256 hashes. The native Windows chooser was substituted with that handle. [Linked images](../tests/icanvas-linked-image-edits.mjs) |
| Portable and visual output | Editable `.croft` and ZIP retained the exact source SHA-256 and separate face settings. SVG contained the processed PNG rather than original bytes. Representative PNG and SVG pixels matched exactly, the live solid patch matched within 2 channel levels, JPG matched within 8 levels, and PDF embedded the same JPG. The ordinary export regression also checked A4 metadata through Poppler. [Image exports](../tests/icanvas-image-exports.mjs) · [Export regression](../tests/icanvas-export.mjs) |
| Backup into a fresh profile | The version 3 workspace backup copied 46,157,054 bytes in 98 writes with a 1 MiB maximum chunk. Sampled JavaScript heap grew about 1.8 MB in that run. Restore verified original image SHA-256, both face settings, project swatches, version and recovery records, and the existing 44 MiB fixture. Chrome used an actual writable file in its private filesystem in place of the OS chooser. [Workspace backup](../tests/icanvas-workspace-backup.mjs) |
| Narrow layout and keyboard | At 390×844 in reduced-motion Chrome, an injected pointer cancellation left Undo disabled, keyboard adjustment still worked, Enter applied the typed angle, partial alpha remained in HEX, and Escape left sampling. Physical touch and additional browsers were outside the image-tool runs. |

The production build and 55 automated tests passed. Use `node tests/icanvas-image-tools.mjs`, `node tests/icanvas-image-rendering.mjs`, `node tests/icanvas-image-exports.mjs` and `node tests/icanvas-linked-image-edits.mjs` with the Chrome and Playwright environment below. Set `CROFT_QA_SCREENSHOTS=screenshots` for synthetic before and after captures. Image edits in animated sources appear as still frames, and visual exports are bounded. [Rendering and package limits](ICANVAS_ARCHITECTURE.md)

## Double-sided cards and stacks

| Check | Evidence |
| --- | --- |
| Card faces and input | A legacy project opened on its original Front with an empty Back. Chrome verified independent edits and the remembered side across reload, mouse double-click on the tab, keyboard Enter and Space, emulated touch at 390×844, reduced motion, Back scrolling and text selection, unchanged card geometry, no hidden playback or focus, and text preservation across a flip. It verified canonical SubCanvas opening from the card body, a synthetic 32,044-byte WAV, and retained Front and Back after Card → Direct → Card. [Card faces](../tests/icanvas-card-faces.mjs) |
| Stack lifecycle and history | Chrome stacked four mixed cards and checked offset edges, count and ordered Layers. It brought members forward, flipped one independently, moved the pile, preserved ordinary overlap, cancelled Add to Stack with Escape, added by deliberate drop, extracted, fanned, restacked and unstacked. Flipping and editing a fanned card preserved its order and geometry. The suite checked delete confirmation, undo and redo and revealed an obscured Back-only search match. [Stacks](../tests/icanvas-stacks.mjs) · [Stack model](../tests/icanvas-stack.test.mjs) |
| Nested transforms | Chrome rotated a two-level frame and group 90° and scaled it 1.5×. The nested stack and its two members transformed once and undo restored their exact positions and sizes. Frame collapse hid stack controls and expansion restored them. An inherited lock disabled moving the pile. [Containers](../tests/icanvas-containers.mjs) |
| Versions, copies and packages | Chrome verified Save VC restore and Save As, including remapped member IDs and an edit to the copy leaving the original intact. `.croft` and ZIP retained both sides, order and hidden attachments. Full workspace restore used an independent Chrome profile and checked exact Back bytes, edges, descendants and snapshots. The measured version 2 backup wrote 46,152,824 bytes in 96 writes with at most 1 MiB per media write. Sampled JS heap grew about 1.7–1.9 MB across two runs. The browser’s private file writer stood in for the OS picker. [Packages](../tests/icanvas-card-packages.test.mjs) · [Workspace backup](../tests/icanvas-workspace-backup.mjs) |
| Single writer and failed save | A second Chrome tab browsed a stack without persisting order. An injected native `QuotaExceededError` retained the pending Back edit and showed Save failed while the committed order and both existing faces remained intact. Retry saved the draft successfully. The existing browser-process crash and lock takeover checks also passed. [Safety](../tests/icanvas-safety.mjs) |
| Static exports | Compared actual compact and fanned PNG downloads against the Chrome editor, including a 19° rotated card within a frame. Verified corresponding visible faces, stack silhouettes and fan positions. Checked all six export formats, image decoding and A4 PDF metadata. Static outputs omit editor controls and use placeholders for unsupported media. [Exports](../tests/icanvas-export.mjs) |
| Large compact stack | The Chrome fixture with 260 image members opened the full count list while mounting one image and three rear silhouettes. A 1,200-member synthetic model test checked the same projection bound. No maximum fan size, frame-rate guarantee or memory bound for a fully visible fan was established. [Stacks](../tests/icanvas-stacks.mjs) · [Stack model](../tests/icanvas-stack.test.mjs) |

The production build and 48 unit tests passed. Run `node tests/icanvas-card-faces.mjs` and `node tests/icanvas-stacks.mjs` with the same Chrome and Playwright environment below. Set `CROFT_QA_SCREENSHOTS=screenshots` for local front, back, compact, fanned and Layers captures. The inputs and captures use synthetic data and remain outside version control.

## Stabilisation verification

| Check | Evidence |
| --- | --- |
| Two editors | A second tab could browse but could not save through the application storage API, even with a newer timestamp. Explicit takeover failed while the writer was open. Closing the writer released the lock. Taking over then showed the previous writer’s committed text. [Safety](../tests/icanvas-safety.mjs) |
| Failed transactions and quota | An invalid parent write aborted and rolled back its staged asset. An injected native IndexedDB `QuotaExceededError` left the current draft visible, retained the saved head and both history types, and showed an error. After the fault was removed, Retry committed the draft. The host accepted a 4 MiB allocation under its experimental quota override, so this result concerns the injected failure path. [Safety](../tests/icanvas-safety.mjs) |
| Abrupt Chrome process crash | Chrome DevTools deliberately terminated the browser process while a synthetic edit was waiting for autosave. Reopening the same disposable profile in a new Chrome process retained the committed head, a version and a recovery entry. The draft that had never reached storage was absent. [Safety](../tests/icanvas-safety.mjs) |
| Streaming workspace backup | A 44 MiB payload wrote 46,150,806 bytes in 94 writes, at most 1 MiB per media write. Sampled Chrome JavaScript heap rose from 18,382,193 to 20,158,501 bytes, about 1.69 MiB, with reusable buffers. This measurement excludes native Blob, file and process memory. Chrome used its private filesystem writer as a test substitute for the OS save picker. [Backup browser test](../tests/icanvas-workspace-backup.mjs) |
| Independent restore and failure | The backup restored into a fresh isolated Chrome context. Tested original attachment bytes, descendant and link IDs, object relationships, Trash, a saved version, and recoveries. Corruption and cancellation left destination data unchanged. Additive restore retained the existing starter project. No third-party HTTP traffic was observed. [Backup browser test](../tests/icanvas-workspace-backup.mjs) |
| Linked files | Chrome’s drag protocol produced real permission-bearing host-file handles. Link In kept the handle and exact downloaded bytes with no copied Blob. Renaming the source produced a missing state. Restoring its original path and checking again brought it back. After a full browser restart, the same stored handle entered `prompt`. Tests separately injected denial and supplied a second real handle in place of the Windows chooser for Relink. Relink kept the canvas object ID and neither source file changed. [Linked files](../tests/icanvas-linked-files.mjs) |
| Canvas input and precision | The Chromium input protocol generated a two-finger gesture from 100% to 200%, moving the midpoint with the world anchor. Both 0.25% and 6,400% wheel clamp points persisted. At world X=1e9 and Y=−2e9, both the selected target and its connector endpoint stayed within 2 CSS pixels of the anchor. A minimap click updated the camera with finite coordinates. Floating toolbar position survived reload. [Scale](../tests/icanvas-scale.mjs) |
| 1,200 objects and 300 edges | Three headless development runs at 1440×950 took 269–376 ms from navigation to canvas readiness. The DOM mounted 48 objects before panning and 72 afterward. Median animation frame intervals were 16.7 ms. The 95th percentiles ranged from 16.8 to 33.3 ms, with a worst observed interval of 66.8 ms. The fixture mixes notes, text, shapes and strokes. These are frame intervals and exclude input-to-display latency and media-heavy boards. [Scale](../tests/icanvas-scale.mjs) |
| Containers and metadata | Browser tests rotated and resized a frame containing another frame, a group and two connected shapes. Every descendant transformed once and undo returned exact persisted coordinates. The same test verified uploaded PNG icon bytes and description, and the icon’s display after reload. Geometry tests cover equal gaps on both axes and rotated frame growth. [Containers](../tests/icanvas-containers.mjs) |
| Frame detachment and existing oversized frames | Chrome imported a synthetic PNG outside Travel notes, assigned it to the frame, then switched Container to Canvas. The frame returned to its earlier bounds immediately while the image kept the same ID and coordinates. Undo, redo and reload preserved the expected membership and geometry. **Fit frame to contents** also trimmed an oversized frame while preserving the attached child and the detached image positions. [Workspace](../tests/icanvas-workspace.mjs) |
| Custom colours, lock, and edge rotation | Chrome verified the wheel and keyboard sliders, HEX/RGB synchronisation, invalid input, Cancel, undo and reload. The picker also worked at 390×844 with touch emulation. A Direct image used the chosen colour for its visible border. The padlock showed the current state and blocked movement when locked. Pointer rotation preserved the initial angle, snapped at 15° and 30°, and supported an Alt override, Escape, undo and reload. [Colour and lock](../tests/icanvas-colour.mjs) · [Rotation](../tests/icanvas-rotate.mjs) |

Run the additional tests from `croft-ui`, using the same Playwright and Chrome paths below. `icanvas-safety.mjs` uses Vite source modules, so run it against the dev server. Destructive operations in the tests are confined to disposable contexts and profiles.

```powershell
node tests/icanvas-safety.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME
node tests/icanvas-scale.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME
node tests/icanvas-containers.mjs
node tests/icanvas-linked-files.mjs
node tests/icanvas-workspace-backup.mjs $env:CROFT_QA_PLAYWRIGHT $env:CROFT_QA_CHROME
```

## Build and tests

- The stabilisation pass ran `npm test` with 32 passing tests and `npm run build` with 2,121 modules bundled. The final regression runs covered the existing Chrome workspace, IndexedDB, save dialogs, media and all six portable/visual export formats alongside the new tests above.
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

- Genuine Windows picker interaction, browser-managed dismissal or manual revocation, physical disk exhaustion, storage eviction, and a process failure during a live IndexedDB commit remain unverified. A crash before a write reaches storage cannot guarantee preservation of those edits. Use the same browser profile and origin to reopen stored data.
- Physical touchscreen, keyboard-only operation, screen-reader behavior, focus restoration and precise editor/export parity have additional cases beyond the tested fixture. Connector routing and freeform frame stretching remain out of scope for the verified transforms.
- Native full workspace backups require a browser writable file picker and cap metadata at 64 MiB. Portable ZIP packages retain their size caps. Static exports were validated for one A4 fit and three SVG descendants. Panoramic readability, multi-page printing, migrations and stress testing on media-heavy scenes remain open. [Export limits](ICANVAS_ARCHITECTURE.md)
