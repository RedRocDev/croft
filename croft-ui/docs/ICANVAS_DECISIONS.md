# iCanvas implementation decisions

13 November 2026. Scope is the existing local Croft browser application. [Architecture](ICANVAS_ARCHITECTURE.md) · [Interface references](ICANVAS_REFERENCES.md) · [Export verification](ICANVAS_EXPORT_QA.md)

## Canvas foundation

**Use React DOM objects and SVG layers over a shared world-to-screen transform.** Keep Croft's existing shell and theme, and make its TypeScript model authoritative for nested projects, media references, and export. HTML controls preserve native semantics for text and media. SVG draws edges and strokes. RBush supplies spatial queries, and the browser Canvas API rasterises the portable SVG. This avoids adapting a second scene schema to Croft's SubCanvas hierarchy and version snapshots. Croft owns gesture handling, selection, edge routing, and parity between the editor and export. The current implementation uses a viewport query and overscan. Measure its workload limits before adding an alternate renderer.

| Candidate | Evidence and decision |
| --- | --- |
| **tldraw SDK** | The SDK's GitHub code and published packages are source available under tldraw's own licence. The default terms permit development. Production use requires a valid trial, discretionary hobby, or commercial licence key. The hobby option requires a visible watermark. Keys are validated locally, and the SDK documents a development exception for localhost. These terms make it possible to evaluate locally. A time-limited or branded release and a downstream key requirement are poor fits for Croft's intended reusable, unbranded baseline. Excluded from the dependency graph. [SDK licence](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) · [Licence options](https://tldraw.dev/community/license) · [Key enforcement](https://tldraw.dev/sdk-features/license-key) |
| **Excalidraw** | The upstream editor is MIT licensed and available as the embeddable `@excalidraw/excalidraw` React package. Its setup guide documents CDN-loaded fonts by default and how to self-host them. This was a viable editor candidate. Its own scene and drawing UI would require adapters for linked projects, Croft media cards, properties, repository-specific controls, and portable snapshots. Retained as an alternative if a later requirement benefits from a general drawing editor. No package installed. [MIT licence](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) · [Embedding and font assets](https://plus.excalidraw.com/docs/sdk/excalidraw/installation) |
| **Konva** | MIT-licensed Canvas 2D scene graph offering object events, transforms, animation, and export. A useful alternative for dense scenes. HTML text editing, embedded media controls, and most Croft navigation would still need DOM integration around it. The current implementation uses browser primitives directly and has no Konva dependency. [MIT licence](https://github.com/konvajs/konva/blob/master/LICENSE) · [Konva capabilities](https://github.com/konvajs/konva) |

## Pinned additions

The [package manifest](../package.json) and [npm lockfile](../package-lock.json) are the version and integrity records for the resolved graph. The direct runtime additions are `rbush` and `fflate`. The shipped bundle continues to use the project's existing React and Lucide dependencies.

| Package | Licence and use |
| --- | --- |
| `rbush@4.0.1` | MIT. Indexes rotated world bounds for the viewport query. [RBush v4.0.1 licence](https://github.com/mourner/rbush/blob/v4.0.1/LICENSE) |
| `quickselect@3.0.0` | ISC. Transitive dependency used by RBush for index construction. [quickselect v3.0.0 licence](https://github.com/mourner/quickselect/blob/v3.0.0/LICENSE) |
| `@types/rbush@4.0.0` | MIT. Development-only type declarations. [DefinitelyTyped declarations](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/rbush) · [DefinitelyTyped licence](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE) |
| `fflate@0.8.3` | MIT. Writes stored ZIP containers for editable projects and bundles of static export files. The application import reader validates its own stored-entry format directly, without an inflate step. [fflate v0.8.3 licence](https://github.com/101arrowz/fflate/blob/v0.8.3/LICENSE) |

Vite copies the runtime dependency licences alongside the browser bundle. The licence links identify the authoritative text for the additions. The runtime uses locally bundled assets and browser primitives. [Third-party notices](../public/third-party-notices.txt) · [Interface reference provenance](ICANVAS_REFERENCES.md)

## Persistence and portability

- Use native IndexedDB for projects, immutable media Blobs, browser file handles where supported, and distinct recovery and version stores. The browser origin is the storage boundary. The application uses a fixed localhost port so it does not silently open another origin's workspace when the port is busy. [IndexedDB specification](https://w3c.github.io/IndexedDB/) · [Vite server configuration](../vite.config.mjs)
- Import copies validated media into IndexedDB by default. Link In preserves an explicitly granted handle if the browser exposes one. Handles can fail after permission changes or file moves. Export includes linked-file metadata and gives the importing workspace a relink path. [File System Access API](https://wicg.github.io/file-system-access/)
- `.croft` and editable `.zip` use the same version 1 container format. An allowlisted archive structure and manifest limits make import predictable. Embedded media checksums detect corrupted bytes. Imports create a fresh identity graph before saving; render-only exports preserve visible layout and do not serve as editable backups. [Format implementation](../src/features/icanvas/portability.ts) · [Export verification](ICANVAS_EXPORT_QA.md)
