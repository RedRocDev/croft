# Croft — Space to grow.

Croft is a localhost workspace for iCanvas projects. Home and the five sidebar utilities remain available alongside the project hierarchy. The original sample handbook and database layouts are accessible from Home and Search.

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
npm test
npm run build
npm run preview
```

The production build goes to `dist/`. The project uses the published WebAssembly variants of the Vite 7 build tools so dependency installation and bundling can run on Windows hosts that restrict native Node add-ons.

## Explore

- Open **Holiday Ideas** on Home to try iCanvas, or choose **New Project** to start a blank canvas. Double-click a SubCanvas tile to open it. The header breadcrumbs lead back through its parents.
- Add notes, shapes, drawings and local files. Use the Properties and Layers tabs to edit objects, or **Add → New SubCanvas** to create child projects. Hold Space and drag to pan. Use **View** for the grid, minimap, edge visibility and inspector.
- Double-click the tab at a note or card’s bottom centre to flip it, or focus the tab and press Enter or Space. On touch, tap once. Use **Properties → Card faces → Edit Back** for reverse-side text or **Add Back attachment** for a local file. Search finds text on either face.
- Select two or more loose cards in the same container, then choose **Stack Cards**. Use the pile’s grip to move it, the exposed edges or count to browse, and the down-arrow handle to pull the front card out. While dragging a loose card, drop it on **Add to Stack** to join the pile. The count menu also offers **Fan Out**, **Restack**, and **Unstack All**.
- Select an image or flip to the card face that contains it. The selection toolbar opens **Crop**, **Adjust**, and **Effects**. **Properties → Image Tools** also has **Looks**, geometric masks and **Colours**, where you can sample the edited image and save reusable canvas swatches. **Compare Original** shows the full source in the same image box. **Reset All Image Edits** resets that face and is undoable.
- Select an audio object or flip to a card face with an audio attachment. In **Properties → Audio**, choose **Waveform** or **Compact**. Open **Waveform** for the base, progress and playhead colours, with the colour picker and project swatches. Click or drag across the waveform to seek. With the waveform focused, Space plays or pauses, arrows seek, and Home and End jump to the start and end.
- Use `Ctrl+K` for workspace Search and `Ctrl+F` to find canvas objects. `Ctrl+S` saves the current canvas. The Save menu also has **Save VC** for versions and **Save As** for a separate project copy.
- Use **Project menu → Export** for editable `.croft` or `.zip` packages that retain both faces and all stack members. SVG, PNG, JPG and PDF show the visible faces and current pile layout. Home can reimport editable packages as distinct projects.
- Use **Home → Backup & restore** for an iCanvas workspace backup. It saves a `.croftbackup` file at the location you choose and includes copied media, Trash, saved versions and temporary recovery copies. Restore adds an independent copy of the backup to the open workspace. External linked files need relinking.
- Open the handbook from Recently visited on Home. Its sample links open the nested pages.
- In the handbook, click the sample sentence “Write down what changed and why.” for the formatting toolbar, or press `/` for the slash menu. The page options menu also opens both previews.
- Open Projects from Home to switch views and preview records. Calendar navigation, filters, sorting and query previews use the same in-memory sample data.
- Use Settings → Preferences → Appearance for light, dark and system views.

iCanvas saves projects and imported media in this browser profile’s IndexedDB at `http://localhost:5173`. Other ports and browser profiles have separate storage. One tab edits at a time. To take over from a read-only tab, close the editing tab and choose **Enable editing**. Unsaved edits may be lost if the browser stops before committing them. Keep `.croftbackup` files outside the browser profile. Portable `.croft` and `.zip` project exports contain the chosen live content and copied media within their displayed limits. Version and recovery history stays in the workspace. File links require browser permission and never copy source bytes unless you explicitly choose Import. Handbook and database examples, sharing, and template controls remain UI fixtures. Theme preview resets when the page reloads.

See the [iCanvas feature matrix](docs/ICANVAS_FEATURE_MATRIX.md), [verification record](docs/ICANVAS_QA.md), and [Mobbin references](docs/ICANVAS_REFERENCES.md). Croft uses the original C logo and its padded display derivative. The cover is original generated workspace artwork, bundled locally.
