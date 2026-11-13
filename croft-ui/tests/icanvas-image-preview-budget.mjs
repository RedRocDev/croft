import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { zipSync } from 'fflate'
import { defaultImageEdits } from '../src/features/icanvas/imageEdits.ts'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a local Croft origin.')
const executablePath = process.env.CROFT_QA_CHROME
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), chromiumSandbox: true })
const stageLimit = 6 * 1024 * 1024
const imageLimit = 3 * 1024 * 1024
const sideLimit = 2304
const canvasSelector = '.ic-world .ic-edited-image-paint canvas'

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push(request.url())
  })
  await page.goto(origin)
  const home = page.getByRole('region', { name: 'Canvas projects' })
  await home.waitFor()
  const encoded = await page.evaluate(() => {
    const source = document.createElement('canvas')
    source.width = 1408
    source.height = 936
    const pen = source.getContext('2d')
    pen.fillStyle = '#3352a2'
    pen.fillRect(0, 0, 1408, 936)
    pen.fillStyle = '#ffaf66'
    for (let x = 2; x < 1408; x += 4) pen.fillRect(x, 0, 2, 936)
    pen.fillStyle = '#8c8c8c'
    pen.fillRect(504, 268, 400, 400)
    return source.toDataURL('image/png').split(',')[1]
  })
  const source = Buffer.from(encoded, 'base64')
  const asset = { id: crypto.randomUUID(), name: 'Synthetic line pattern.png', mime: 'image/png', size: source.length,
    path: 'assets/00000.bin', sha256: createHash('sha256').update(source).digest('hex') }
  const project = createProject('Image preview budget fixture')
  project.camera = { x: 40, y: 32, zoom: 1 }
  project.settings.panel = 'closed'
  project.settings.minimap = false
  const edits = { ...defaultImageEdits, tone: { ...defaultImageEdits.tone, warmth: 18, contrast: 10 } }
  const imageCount = 13
  project.objects = Array.from({ length: imageCount - 1 }, (_, index) => makeObject('image', { x: 100 + index * 5, y: 135 + index * 2 }, {
    name: `Overlapping image ${index + 1}`, width: 1080, height: 720, assetId: asset.id, imageEdits: edits,
  }))
  project.objects.push(makeObject('image', { x: 290, y: 65 }, {
    name: 'Two-sided image', mode: 'card', width: 420, height: 365, assetId: asset.id, imageEdits: edits,
    back: { title: 'Reverse image', text: '', assetId: asset.id, imageEdits: { ...edits, tone: { ...edits.tone, warmth: -22 } } },
  }))
  const archive = zipSync({ 'manifest.json': new TextEncoder().encode(JSON.stringify({ format: 'croft-icanvas', version: 3, projects: [project], assets: [asset] })),
    [asset.path]: source }, { level: 0 })
  await home.locator('input[accept=".croft,.zip"]').setInputFiles({ name: 'image-preview-budget.croft', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await home.getByRole('button', { name: /^Image preview budget fixture/ }).click()
  const stage = page.getByRole('region', { name: 'Canvas', exact: true })
  await stage.waitFor()

  await page.evaluate((selector) => {
    const measurements = { peakTotal: 0, peakImage: 0, peakSide: 0, samples: 0, lastResize: performance.now() }
    let lastSizes = ''
    window.qaPreviewMeasurements = measurements
    const sample = () => {
      let total = 0
      const sizes = []
      for (const canvas of document.querySelectorAll(selector)) {
        const pixels = canvas.width * canvas.height
        total += pixels
        sizes.push(canvas.width + '×' + canvas.height)
        measurements.peakImage = Math.max(measurements.peakImage, pixels)
        measurements.peakSide = Math.max(measurements.peakSide, canvas.width, canvas.height)
      }
      const nextSizes = sizes.join(',')
      if (lastSizes !== nextSizes) {
        lastSizes = nextSizes
        measurements.lastResize = performance.now()
      }
      measurements.peakTotal = Math.max(measurements.peakTotal, total)
      measurements.samples++
    }
    const stage = document.querySelector('.ic-stage')
    window.qaPreviewObserver = new MutationObserver(sample)
    window.qaPreviewObserver.observe(stage, { subtree: true, childList: true, attributes: true, attributeFilter: ['width', 'height'] })
    sample()
  }, canvasSelector)

  const button = name => page.getByRole('button', { name, exact: true })
  const canvases = page.locator(canvasSelector)
  async function waitForCanvases() {
    await page.waitForFunction(({ selector, count }) => {
      const nodes = Array.from(document.querySelectorAll(selector))
      return nodes.length === count && nodes.every(canvas => canvas.width > 0 && canvas.height > 0)
    }, { selector: canvasSelector, count: imageCount })
  }
  async function waitForAllocation() {
    await waitForCanvases()
    await page.waitForFunction(() => performance.now() - window.qaPreviewMeasurements.lastResize > 180)
    await waitForCanvases()
  }
  const totals = () => canvases.evaluateAll(nodes => ({ count: nodes.length,
    pixels: nodes.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
    largest: Math.max(...nodes.map(canvas => canvas.width * canvas.height)) }))

  await waitForCanvases()
  const card = page.locator('.ic-item[aria-label="Two-sided image"]')
  const cardCanvas = card.locator('.ic-edited-image-paint canvas')
  const centreColour = storeFront => cardCanvas.evaluate((canvas, store) => {
    if (store) window.qaFrontPreview = canvas
    const [red, , blue] = canvas.getContext('2d').getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data
    return red - blue
  }, storeFront)
  assert.ok(await centreColour(true) > 10, 'The edited front renders its warm colour setting.')
  await card.getByRole('button', { name: 'Show back of card', exact: true }).press('Enter')
  await card.locator('[aria-label="Synthetic line pattern.png"] canvas').waitFor()
  await page.waitForFunction(() => window.qaFrontPreview.width === 0 && window.qaFrontPreview.height === 0)
  assert.ok(await centreColour(false) < -10, 'The back renders its independent cool colour setting.')
  await card.getByRole('button', { name: 'Show front of card', exact: true }).press('Enter')
  await waitForAllocation()
  assert.ok(await centreColour(false) > 10, 'Flipping the back preserves the front edit.')
  const at100 = await totals()

  for (let index = 0; index < 3; index++) await button('Zoom out').click()
  assert.equal(await button('Zoom settings').innerText(), '51%')
  await page.waitForFunction(selector => {
    const direct = Array.from(document.querySelectorAll(selector))
      .filter(canvas => canvas.closest('.ic-item')?.getAttribute('aria-label')?.startsWith('Overlapping image '))
    return direct.length === 12 && direct.every(canvas => canvas.width > 0 && canvas.width < 600)
  }, canvasSelector)
  await waitForAllocation()
  const at51 = await totals()
  for (let index = 0; index < 7; index++) await button('Zoom in').click()
  assert.equal(await button('Zoom settings').innerText(), '244%')
  await page.waitForFunction(selector => {
    const card = document.querySelector('.ic-item[aria-label="Two-sided image"]')
    return (card?.querySelector(selector)?.width ?? 0) > 420
  }, '.ic-edited-image-paint canvas')
  await waitForAllocation()
  const at244 = await totals()
  assert.ok(at51.pixels < stageLimit / 2, `The overview used ${at51.pixels} pixels and should use substantially less than the shared budget.`)
  assert.ok(at100.pixels > at51.pixels && at244.pixels > at51.pixels)
  assert.ok(at244.pixels <= stageLimit && at244.largest <= imageLimit)

  const box = await stage.boundingBox()
  assert.ok(box)
  const world = stage.locator('.ic-world').first()
  await button('Hand').click()
  async function pan(x, y) {
    const from = { x: box.x + box.width - 80, y: box.y + box.height - 120 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + x, from.y + y, { steps: 10 })
    await page.mouse.up()
  }
  const beforePan = await world.evaluate(node => node.style.transform)
  await canvases.evaluateAll(nodes => { window.qaPreviewReferences = nodes })
  await pan(-8, -6)
  assert.notEqual(await world.evaluate(node => node.style.transform), beforePan)
  await waitForCanvases()
  assert.equal(await canvases.evaluateAll(nodes => nodes.every(node => window.qaPreviewReferences.includes(node))), true,
    'Panning with the same image population and zoom should reuse the backing canvases.')

  for (let index = 0; index < 5; index++) await pan(-box.width + 150, -box.height + 240)
  await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0, canvasSelector)
  await page.waitForFunction(() => window.qaPreviewReferences.every(canvas => canvas.width === 0 && canvas.height === 0))
  const peaks = await page.evaluate(() => {
    window.qaPreviewObserver.disconnect()
    const { peakTotal, peakImage, peakSide, samples } = window.qaPreviewMeasurements
    return { peakTotal, peakImage, peakSide, samples }
  })
  assert.ok(peaks.samples > 3)
  assert.ok(peaks.peakTotal <= stageLimit, `Stage backing peaked at ${peaks.peakTotal} pixels.`)
  assert.ok(peaks.peakImage <= imageLimit, `An image backing peaked at ${peaks.peakImage} pixels.`)
  assert.ok(peaks.peakSide <= sideLimit, `A backing edge peaked at ${peaks.peakSide} pixels.`)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ chrome: browser.version(), at51, at100, at244, peaks, released: imageCount }, null, 2))
} finally {
  await browser.close()
}
