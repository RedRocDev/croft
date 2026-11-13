import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { defaultImageEdits } from '../src/features/icanvas/imageEdits.ts'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a local Croft origin.')
const executablePath = process.env.CROFT_QA_CHROME
const screenshots = process.env.CROFT_QA_SCREENSHOTS
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), chromiumSandbox: true })

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, acceptDownloads: true, reducedMotion: 'reduce' })
  const errors = []
  const external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url())
  })
  await page.goto(origin)
  await page.locator('.ic-project-open').first().waitFor()
  const chart = await page.evaluate(() => {
    const source = document.createElement('canvas')
    source.width = 4608
    source.height = 3072
    const pen = source.getContext('2d')
    pen.fillStyle = '#eb7449'
    pen.fillRect(0, 0, source.width, source.height)
    const crop = { x: 384, y: 256, width: 3840, height: 2560 }
    const sky = pen.createLinearGradient(0, crop.y, 0, crop.y + crop.height)
    sky.addColorStop(0, '#bedcf2')
    sky.addColorStop(.54, '#526e98')
    sky.addColorStop(1, '#31384a')
    pen.fillStyle = sky
    pen.fillRect(crop.x, crop.y, crop.width, crop.height)
    pen.fillStyle = '#b35d38'
    pen.beginPath()
    pen.arc(2304, 1230, 264, 0, Math.PI * 2)
    pen.fill()
    const stripes = [2, 4, 8, 16]
    stripes.forEach((thickness, index) => {
      const left = 1472 + index * 432
      pen.fillStyle = '#d4d6db'
      pen.fillRect(left, 1472, 384, 448)
      pen.fillStyle = '#273243'
      for (let offset = 0; offset < 384; offset += thickness * 2) pen.fillRect(left + offset, 1472, thickness, 448)
    })
    return { source: { width: source.width, height: source.height }, crop, base64: source.toDataURL('image/png').split(',')[1] }
  })
  const sourceBytes = Buffer.from(chart.base64, 'base64')
  const asset = { id: crypto.randomUUID(), name: 'Synthetic fine-detail image.png', mime: 'image/png', size: sourceBytes.length,
    path: 'assets/00000.bin', sha256: hash(sourceBytes) }
  const project = createProject('Image resolution fixture')
  project.camera = { x: 0, y: -30, zoom: 1 }
  project.settings.grid = 'none'
  project.settings.minimap = false
  const { crop, source } = chart
  const imageEdits = { ...defaultImageEdits, source,
    crop: { x: crop.x / source.width, y: crop.y / source.height, width: crop.width / source.width, height: crop.height / source.height },
    tone: { ...defaultImageEdits.tone, warmth: 20, saturation: -15, contrast: 12 } }
  project.objects = [makeObject('image', { x: 0, y: 0 }, { width: 1440, height: 960, name: asset.name, assetId: asset.id, imageEdits })]
  const fixtureArchive = zipSync({
    'manifest.json': new TextEncoder().encode(JSON.stringify({ format: 'croft-icanvas', version: 3, projects: [project], assets: [asset] })),
    [asset.path]: sourceBytes,
  }, { level: 0 })
  const home = page.getByRole('region', { name: 'Canvas projects' })
  await home.locator('input[accept=".croft,.zip"]').setInputFiles({ name: 'resolution-fixture.croft', mimeType: 'application/zip', buffer: Buffer.from(fixtureArchive) })
  await home.getByRole('button', { name: /^Image resolution fixture/ }).click()
  const canvas = page.locator('.ic-edited-image-paint canvas')
  await canvas.waitFor()
  const button = name => page.getByRole('button', { name, exact: true })
  const metrics = []
  const previews = []
  if (screenshots) await mkdir(screenshots, { recursive: true })
  const capture = async (label, expectedZoom, expectedWidth) => {
    const zoom = Number.parseFloat(await button('Zoom settings').innerText())
    assert.equal(zoom, expectedZoom)
    await page.waitForFunction(width => document.querySelector('.ic-edited-image-paint canvas')?.width === width, expectedWidth)
    const result = await canvas.evaluate(element => {
      const projected = element.getBoundingClientRect()
      return { backing: [element.width, element.height], projected: [Math.round(projected.width), Math.round(projected.height)] }
    })
    metrics.push({ zoom, ...result })
    previews.push(await canvas.evaluate(element => element.toDataURL('image/png').split(',')[1]))
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `icanvas-image-resolution-${label}.png`) })
  }
  await capture('100', 100, 1440)
  for (let click = 0; click < 3; click++) await button('Zoom out').click()
  await capture('51', 51, 737)
  for (let click = 0; click < 7; click++) await button('Zoom in').click()
  await capture('244', 244, 2172)
  assert.deepEqual(metrics.map(entry => entry.backing), [[1440, 960], [737, 491], [2172, 1448]])
  assert.deepEqual(metrics.map(entry => entry.projected), [[1440, 960], [737, 492], [3516, 2344]])

  async function download(format) {
    await button('Project menu').click()
    await button('Export').click()
    const dialog = page.getByRole('dialog', { name: 'Export canvas' })
    await dialog.getByLabel('Format').selectOption(format)
    await dialog.getByLabel('Scope').selectOption('canvas')
    if (format !== 'croft') await dialog.getByLabel('Background').selectOption('transparent')
    const [file] = await Promise.all([page.waitForEvent('download'), button('Export').click()])
    assert.equal(await file.failure(), null)
    await dialog.waitFor({ state: 'hidden' })
    return readFile(await file.path())
  }

  const svg = (await download('svg')).toString()
  const flattened = svg.match(/<image href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/)?.[1]
  assert.ok(flattened, 'Edited SVG embeds a flattened PNG.')
  const staticPng = await download('png')
  const archive = unzipSync(await download('croft'))
  const manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString())
  const original = Buffer.from(archive[manifest.assets[0].path])
  assert.equal(hash(original), asset.sha256, 'Editable package retains the exact original source bytes.')
  assert.notEqual(hash(Buffer.from(flattened, 'base64')), asset.sha256)
  assert.deepEqual(manifest.projects[0].objects[0].imageEdits, imageEdits)

  const resolution = await page.evaluate(async ({ previews, flattened, output, original }) => {
    async function read(encoded) {
      const image = new Image()
      image.src = `data:image/png;base64,${encoded}`
      await image.decode()
      const raster = document.createElement('canvas')
      raster.width = image.naturalWidth
      raster.height = image.naturalHeight
      const context = raster.getContext('2d')
      context.drawImage(image, 0, 0)
      return { raster, context }
    }

    function contrast({ raster, context }, insetX, insetY, cropWidth, cropHeight) {
      const zone = { x: insetX + 1088 / 3840 * cropWidth, y: insetY + 1500 / 2560 * cropHeight, width: 384 / 3840 * cropWidth }
      const left = Math.ceil(zone.x + 1)
      const width = Math.floor(zone.width - 3)
      const strip = context.getImageData(left, Math.floor(zone.y), width, 1).data
      const samples = Array.from({ length: width }, (_, index) => .2126 * strip[index * 4] + .7152 * strip[index * 4 + 1] + .0722 * strip[index * 4 + 2])
      return { resolution: [raster.width, raster.height], fineStripeLumaRange: Math.round(Math.max(...samples) - Math.min(...samples)) }
    }

    const source = await read(original)
    const adaptive = await Promise.all(previews.map(read))
    const embedded = await read(flattened)
    const png = await read(output)
    return {
      source: contrast(source, 384, 256, 3840, 2560),
      previews: adaptive.map(preview => contrast(preview, 0, 0, preview.raster.width, preview.raster.height)),
      embedded: contrast(embedded, 0, 0, 1600, 1600 / 1.5),
      png: contrast(png, 32, 32, 1440, 960),
      solid: [...adaptive, embedded, png].map(({ raster, context }, index) => {
        const edge = index === adaptive.length + 1 ? 32 : 0
        return [...context.getImageData(Math.floor((raster.width - edge * 2) * .32 + edge), Math.floor((raster.height - edge * 2) * .4 + edge), 1, 1).data]
      }),
    }
  }, { previews, flattened, output: staticPng.toString('base64'), original: original.toString('base64') })

  assert.deepEqual(resolution.source.resolution, [source.width, source.height])
  assert.deepEqual(resolution.embedded.resolution, [1600, 1067])
  assert.deepEqual(resolution.png.resolution, [1504, 1024])
  assert.ok(resolution.previews[1].fineStripeLumaRange < resolution.embedded.fineStripeLumaRange, 'The zoomed-out preview can show less fine detail than export.')
  assert.ok(resolution.previews[0].fineStripeLumaRange > resolution.previews[1].fineStripeLumaRange + 30, 'The 100% preview must resolve more of the test stripes.')
  assert.ok(resolution.previews[2].fineStripeLumaRange >= resolution.embedded.fineStripeLumaRange - 10, 'The 244% preview must approach the exported photo detail.')
  assert.ok(resolution.solid.every(pixel => pixel.every((value, index) => Math.abs(value - resolution.solid[0][index]) <= 3)), 'Solid image content agrees across preview and export.')
  if (screenshots) await writeFile(path.join(screenshots, 'icanvas-image-resolution-export.png'), staticPng)
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  console.log(JSON.stringify({ chrome: browser.version(), origin, bytes: asset.size, digest: asset.sha256,
    crop: [crop.width, crop.height], zoom: metrics, resolution }, null, 2))
} finally {
  await browser.close()
}
