# iCanvas export and reimport verification

13 November 2026. The browser test passed against `http://localhost:5173` in a fresh, headless Chrome 157.0.8103.78 context on Windows x64, with the Chromium sandbox enabled. The test used the seeded Holiday Ideas canvas, its two nested canvases, and one synthetic text attachment. It recorded zero page errors and zero non-local HTTP requests.

| Download | Bytes | Verification |
| --- | ---: | --- |
| `Holiday Ideas.svg` | 3,656 | Chrome decoded the SVG. The export contained the canvas heading and included the selected grid background. |
| `Holiday Ideas.png` | 49,553 | PNG signature matched. Chrome decoded the image at the expected dimensions and the corner alpha was transparent. |
| `Holiday Ideas.jpg` | 41,141 | JPEG signature matched. Chrome decoded the image at the expected dimensions and the corner alpha was opaque. |
| `Holiday Ideas.pdf` | 41,835 | Header and trailer matched PDF. Poppler `pdfinfo` opened it and reported one A4 page. |
| `Holiday Ideas.croft` | 8,820 | The version 1 manifest preserved the original root, children, and synthetic attachment bytes. |
| `Holiday Ideas.zip` | 8,820 | The editable ZIP contained the same native manifest and asset as `.croft`. |
| `Holiday Ideas-svg.zip` | 6,036 | Including all SubCanvases on visual export produced three separate SVG files. |

The Home import control reimported the `.croft` download as a second project. Its attachment link appeared on the canvas. Re-export of the imported copy confirmed that the root ID and asset ID changed, the child and SubCanvas target pointed to the imported hierarchy, and the attachment bytes were unchanged. The test keeps the temporary Chrome profile and downloads isolated from the active user workspace.

The browser run exercised current-canvas and descendant scopes. The Node regression suite separately exercised editable selection scope and archive rejection. Visual exports have bounded resolution, and the verified PDF is a raster A4 fit. Fidelity of unusually wide canvases, full PDF rendering across viewers, and linked-file permission restoration remain outside this run.

From `croft-ui`, with the dev server already running:

```powershell
$croftPlaywright = $env:CROFT_QA_PLAYWRIGHT  # Directory of an installed Playwright package
$croftChrome = $env:CROFT_QA_CHROME          # Path to a sandbox-capable Chrome executable
$croftPdfInfo = (Get-Command pdfinfo).Source
node tests/icanvas-export.mjs $croftPlaywright $croftChrome 'http://localhost:5173' $croftPdfInfo
node --test tests/icanvas-portability.test.mjs
```
