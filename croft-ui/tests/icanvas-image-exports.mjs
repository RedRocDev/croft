import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const [playwrightPath, chromePath, origin = 'http://localhost:5173', screenshotsDirectory] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide Playwright and Chrome paths.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, acceptDownloads: true, reducedMotion: 'reduce' })
  const errors = []
  const network = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(origin).origin) network.push(request.url())
  })
  await page.goto(origin)
  await page.locator('.ic-project-open').first().waitFor()
  const fixture = await page.evaluate(async () => {
    const { createProject, makeObject } = await import('/src/features/icanvas/model.ts')
    const { defaultImageEdits } = await import('/src/features/icanvas/imageEdits.ts')
    const { saveProjects } = await import('/src/features/icanvas/storage.ts')
    const surface = document.createElement('canvas')
    surface.width = 160
    surface.height = 120
    const context = surface.getContext('2d')
    context.fillStyle = '#e02535'
    context.fillRect(0, 0, 80, 120)
    context.fillStyle = '#309040'
    context.fillRect(80, 0, 80, 85)
    context.fillStyle = '#3561d2'
    context.fillRect(80, 85, 80, 25)
    const original = surface.toDataURL('image/png')
    const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'))
    const source = { id: 'image-export-original', name: 'Synthetic chart.png', mime: blob.type, size: blob.size, blob }
    const missing = { id: 'image-export-missing', name: 'Unavailable chart.png', mime: blob.type, size: blob.size, linked: true }
    const template = structuredClone(defaultImageEdits)
    const edits = { ...template, source: { width: 160, height: 120 }, crop: { x: .5, y: 0, width: .5, height: 1 }, straighten: 6,
      tone: { ...template.tone, brightness: 10, warmth: 16, tint: -5 }, look: { name: 'sepia', intensity: 35 },
      mask: { ...template.mask, shape: 'circle' }, outline: { enabled: true, colour: '#253dca', width: 5 },
      shadow: { enabled: true, colour: '#2a1368', opacity: 65, x: 20, y: 26, blur: 8 } }
    const originalProject = createProject('Original visual fixture')
    originalProject.objects = [makeObject('image', { x: 120, y: 140 }, { width: 216, height: 152, name: source.name, assetId: source.id })]
    const edited = createProject('Edited visual fixture')
    edited.objects = [{ ...originalProject.objects[0], id: crypto.randomUUID(), imageEdits: edits }]
    const blocked = createProject('Unavailable visual fixture')
    blocked.objects = [{ ...edited.objects[0], id: crypto.randomUUID(), assetId: missing.id }]
    await saveProjects([originalProject, edited, blocked], [source, missing])
    return { original: originalProject.id, edited: edited.id, blocked: blocked.id, source: original.split(',')[1], edits }
  })

  async function openCanvas(id) {
    await page.goto(`${origin}/?image-export-fixture=${id}#canvas/${id}`)
    await page.getByRole('region', { name: 'Canvas', exact: true }).waitFor()
  }

  async function openExport(format, background) {
    await page.getByRole('button', { name: 'Project menu' }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export canvas' })
    await dialog.getByLabel('Format').selectOption(format)
    await dialog.getByLabel('Scope').selectOption('canvas')
    if (background) await dialog.getByLabel('Background').selectOption(background)
    return dialog
  }

  async function download(format, background) {
    const dialog = await openExport(format, background)
    const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export', exact: true }).click()])
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await file.failure(), null)
    return readFile(await file.path())
  }

  async function readPixels(bytes, type, points) {
    return page.evaluate(async ({ url, points }) => {
      const image = new Image()
      image.src = url
      await image.decode()
      const surface = document.createElement('canvas')
      surface.width = image.naturalWidth
      surface.height = image.naturalHeight
      const context = surface.getContext('2d')
      context.drawImage(image, 0, 0)
      return { width: surface.width, height: surface.height,
        samples: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) }
    }, { url: `data:${type};base64,${bytes.toString('base64')}`, points })
  }

  await openCanvas(fixture.original)
  await page.getByRole('img', { name: 'Synthetic chart.png' }).waitFor()
  if (screenshotsDirectory) {
    await mkdir(screenshotsDirectory, { recursive: true })
    await page.screenshot({ path: path.join(screenshotsDirectory, 'icanvas-images-before.png'), animations: 'disabled' })
  }
  const original = await download('svg', 'transparent')
  const originalAsset = Buffer.from(fixture.source, 'base64')
  assert.ok(original.toString().includes(fixture.source))
  const originalImage = await readPixels(original, 'image/svg+xml', [])

  await openCanvas(fixture.edited)
  await page.locator('.ic-edited-image-paint canvas').waitFor()
  if (screenshotsDirectory) await page.screenshot({ path: path.join(screenshotsDirectory, 'icanvas-images-after.png'), animations: 'disabled' })
  const svg = await download('svg', 'transparent')
  const svgText = svg.toString()
  assert.equal(svgText.includes(fixture.source), false, 'Never embed recoverable source pixels in edited SVG.')
  const embeddedUri = svgText.match(/<image href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/)?.[1]
  assert.ok(embeddedUri, 'The SVG needs bounded, flattened pixels for the edited image.')
  const [left, top] = svgText.match(/viewBox="([^ ]+) ([^ ]+) /).slice(1).map(Number)
  const world = (x, y) => [x - left, y - top]
  const points = [world(228, 192), world(228, 274), world(120, 140), world(248, 306), [0, 0]]
  const svgImage = await readPixels(svg, 'image/svg+xml', points)
  assert.ok(svgImage.width > originalImage.width && svgImage.height > originalImage.height, 'Effects expand export bounds.')
  assert.equal(svgImage.samples[0][3], 255)
  assert.ok(svgImage.samples[0][1] > svgImage.samples[0][0])
  assert.ok(svgImage.samples[1][2] > svgImage.samples[1][0], `Expected the retained blue chart patch, received ${svgImage.samples[1]}`)
  assert.equal(svgImage.samples[2][3], 0, 'The circle leaves the rectangular corner transparent.')
  assert.ok(svgImage.samples[3][3] > 0, 'The lower shadow remains visible past the object bounds.')
  assert.equal(svgImage.samples[4][3], 0)
  const live = await page.locator('.ic-edited-image-paint canvas').evaluate(canvas => {
    const context = canvas.getContext('2d')
    const left = -parseFloat(canvas.style.left)
    const top = -parseFloat(canvas.style.top)
    const scale = canvas.width / parseFloat(canvas.style.width)
    return Array.from(context.getImageData(Math.floor((left + 108) * scale), Math.floor((top + 52) * scale), 1, 1).data)
  })
  assert.ok(svgImage.samples[0].every((value, index) => Math.abs(live[index] - value) <= 2), 'Live and exported solid pixels agree.')

  const png = await readPixels(await download('png', 'transparent'), 'image/png', points)
  assert.deepEqual(png, svgImage)
  const jpeg = await download('jpg', 'clean')
  const jpg = await readPixels(jpeg, 'image/jpeg', points)
  assert.deepEqual([jpg.width, jpg.height], [svgImage.width, svgImage.height])
  assert.ok(jpg.samples[0].every((value, index) => Math.abs(svgImage.samples[0][index] - value) <= 8))
  assert.equal(jpg.samples[4][3], 255)
  const pdf = await download('pdf', 'clean')
  assert.match(pdf.subarray(0, 8).toString('ascii'), /^%PDF-1\.4/)
  assert.ok(pdf.includes(jpeg), 'The PDF contains exactly the same processed image as the JPEG export.')

  for (const format of ['croft', 'zip']) {
    const archive = unzipSync(await download(format))
    const manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString())
    assert.equal(manifest.version, 3)
    assert.deepEqual(manifest.projects[0].objects[0].imageEdits, fixture.edits)
    assert.equal(digest(archive[manifest.assets[0].path]), digest(originalAsset))
  }

  await openCanvas(fixture.blocked)
  const preflight = await openExport('svg')
  await preflight.getByRole('region', { name: 'Edited images blocking visual export' }).getByText(/Unavailable chart\.png/).waitFor()
  assert.equal(await preflight.getByRole('button', { name: 'Export', exact: true }).isDisabled(), true)
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [])
  console.log(`Chrome ${browser.version()}: SVG/PNG pixels matched exactly, JPEG channels stayed within 8, PDF embedded that JPEG, and v3 preserved source SHA-256 ${digest(originalAsset)}. Missing linked sources blocked visual export. No runtime network requests.`)
} finally {
  await browser.close()
}
