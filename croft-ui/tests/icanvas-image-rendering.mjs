import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173')
assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))

const browser = await chromium.launch({
  ...(process.env.CROFT_QA_CHROME ? { executablePath: process.env.CROFT_QA_CHROME } : { channel: 'chrome' }),
  headless: true, chromiumSandbox: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 860 }, deviceScaleFactor: 2 })
  const external = []
  page.on('request', request => {
    const address = new URL(request.url())
    if (['https:', 'http:'].includes(address.protocol) && address.origin !== origin.origin) external.push(address.href)
  })
  await page.goto(origin.href)
  const result = await page.evaluate(async () => {
    const { loadImage, renderEditedImage, renderCropSource, sampleRenderedImage } = await import('/src/features/icanvas/imageRendering.ts')
    const { defaultImageEdits } = await import('/src/features/icanvas/imageEdits.ts')
    const chart = document.createElement('canvas')
    chart.width = 400
    chart.height = 200
    const painter = chart.getContext('2d')
    painter.fillStyle = '#b02c00'
    painter.fillRect(0, 0, 200, 100)
    painter.fillStyle = '#0a91e6'
    painter.fillRect(200, 0, 200, 100)
    painter.fillStyle = '#10804c80'
    painter.fillRect(0, 100, 200, 100)
    const url = chart.toDataURL()
    const photo = await loadImage(url)
    const frame = { width: 270, height: 120 }
    const raster = settings => renderEditedImage(photo, settings, frame)
    const pixels = (result, positions) => positions.map(([x, y]) => sampleRenderedImage(result, x, y) ?? null)
    const starting = raster(defaultImageEdits)
    const crop = { ...defaultImageEdits, crop: { x: .5, y: 0, width: .5, height: .5 } }
    const cropRender = raster(crop)
    const warm = raster({ ...crop, tone: { ...crop.tone, warmth: 40 } })
    const straightened = raster({ ...defaultImageEdits, straighten: 32 })
    const cropView = renderCropSource(photo, 32, 384)
    const mask = { ...defaultImageEdits, mask: { ...defaultImageEdits.mask, shape: 'circle' } }
    const circle = raster(mask)
    const oval = raster({ ...mask, mask: { ...mask.mask, shape: 'oval' } })
    const rounded = raster({ ...mask, mask: { ...mask.mask, shape: 'rounded', radius: 50 } })
    const moved = raster({ ...mask, mask: { ...mask.mask, x: 1, y: -1, scale: 1.5 } })
    const effect = raster({ ...crop, mask: mask.mask,
      outline: { enabled: true, colour: '#fad021', width: 6 },
      shadow: { enabled: true, colour: '#222222', opacity: 75, x: 18, y: 18, blur: 8 } })
    const { canvas: rendered, scale, insets } = effect
    const ctx = rendered.getContext('2d')
    const inspect = (x, y) => [...ctx.getImageData(Math.round((insets.left + x) * scale), Math.round((insets.top + y) * scale), 1, 1).data]
    const outside = inspect(frame.width / 2 + 18, frame.height + 11)
    const outlineSample = inspect(frame.width / 2, -1)
    const upperPad = [...ctx.getImageData(0, 0, rendered.width, 1).data].every((value, index) => index % 4 !== 3 || !value)
    let wrongDimensions
    try { raster({ ...crop, source: { width: 300, height: 200 } }) } catch (error) { wrongDimensions = error.message }

    // Orientation 6 rotates a 100×60 landscape JPEG 90° clockwise. Insert a
    // minimal little-endian EXIF orientation segment into a synthetic JPEG.
    const jpeg = document.createElement('canvas')
    jpeg.width = 100
    jpeg.height = 60
    const jpegPainter = jpeg.getContext('2d')
    jpegPainter.fillStyle = '#e12c00'
    jpegPainter.fillRect(0, 0, 50, 60)
    jpegPainter.fillStyle = '#1464d4'
    jpegPainter.fillRect(50, 0, 50, 60)
    const rawJpegBlob = await new Promise(resolve => jpeg.toBlob(resolve, 'image/jpeg', .98))
    const rawJpeg = new Uint8Array(await rawJpegBlob.arrayBuffer())
    const exif = new Uint8Array([0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0,
      0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0])
    const orientedUrl = URL.createObjectURL(new Blob([rawJpeg.slice(0, 2), exif, rawJpeg.slice(2)], { type: 'image/jpeg' }))
    const portrait = await loadImage(orientedUrl)
    const portraitResult = renderEditedImage(portrait, { ...defaultImageEdits, source: { width: 60, height: 100 } }, { width: 60, height: 100 })
    const portraitSamples = pixels(portraitResult, [[.5, .2], [.5, .8]])
    URL.revokeObjectURL(orientedUrl)

    // Exercise a decoded 12.6 MP photo but time only the bounded interactive drawing stages.
    const largeChart = document.createElement('canvas')
    largeChart.width = 4096
    largeChart.height = 3072
    const largePainter = largeChart.getContext('2d')
    largePainter.fillStyle = '#838ba3'
    largePainter.fillRect(0, 0, 4096, 3072)
    const blob = await new Promise(resolve => largeChart.toBlob(resolve))
    const largeUrl = URL.createObjectURL(blob)
    const large = await loadImage(largeUrl)
    const renderTimes = []
    for (let index = 0; index < 8; index++) {
      const started = performance.now()
      const drawn = renderEditedImage(large, { ...defaultImageEdits, tone: { ...defaultImageEdits.tone, contrast: index * 10, warmth: 10 } },
        { width: 1200, height: 900, maxSide: 768 })
      renderTimes.push(performance.now() - started)
      if (drawn.canvas.width > 768 || drawn.canvas.height > 768) throw new Error('Interactive preview exceeded the configured 768px edge.')
    }
    URL.revokeObjectURL(largeUrl)
    return {
      sourceIntact: url === chart.toDataURL(), size: [photo.naturalWidth, photo.naturalHeight], dimensions: wrongDimensions,
      samples: pixels(starting, [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]),
      crop: pixels(cropRender, [[.5, .5], [.01, .01]]), warm: pixels(warm, [[.5, .5]]),
      rotation: pixels(straightened, [[.07, .04], [.7, .45]]), cropRotationAlpha: cropView.getContext('2d').getImageData(4, 4, 1, 1).data[3],
      circle: pixels(circle, [[.25, .25], [.46, .4], [.26, .44]]),
      oval: pixels(oval, [[.25, .25], [.05, .42]]), rounded: pixels(rounded, [[.01, .01], [.29, .14]]),
      moved: pixels(moved, [[.48, .45], [.55, .46]]),
      outlines: { outside, outlineSample, upperPad }, renderTimes,
      orientation: [portrait.naturalWidth, portrait.naturalHeight], portraitSamples,
    }
  })
  assert.equal(result.sourceIntact, true)
  assert.deepEqual(result.size, [400, 200])
  assert.deepEqual(result.orientation, [60, 100])
  assert.ok(result.portraitSamples[0].r > 200 && result.portraitSamples[0].b < 10)
  assert.ok(result.portraitSamples[1].r < 30 && result.portraitSamples[1].b > 190)
  assert.match(result.dimensions, /source dimensions changed/)
  assert.equal(result.samples[0].hex, '#b02c00')
  assert.equal(result.samples[1].hex, '#0a91e6')
  assert.equal(result.samples[2].alpha, .502)
  assert.equal(result.samples[3], null)
  assert.equal(result.crop[0].hex, '#0a91e6')
  assert.equal(result.crop[1], null)
  assert.equal(result.warm[0].hex, '#2091d0')
  assert.equal(result.rotation[0], null)
  assert.equal(result.cropRotationAlpha, 0)
  assert.ok(result.rotation[1]?.alpha > .5)
  assert.equal(result.circle[0], null)
  assert.ok(result.circle[1]?.alpha > .5)
  assert.equal(result.circle[2], null)
  assert.ok(result.oval.every(sample => sample?.alpha > .5))
  assert.equal(result.rounded[0], null)
  assert.ok(result.rounded[1]?.alpha > .5)
  assert.notDeepEqual(result.moved[0], result.circle[1])
  assert.ok(result.outlines.outside[3] > 0, JSON.stringify(result.outlines))
  assert.deepEqual(result.outlines.outlineSample, [250, 208, 33, 255])
  assert.equal(result.outlines.upperPad, true)
  assert.deepEqual(external, [])
  console.log(`Chrome ${browser.version()} image renderer checks passed at device scale 2. A 4096×3072 source rendered 8 colour previews capped at 768px in ${result.renderTimes.map(time => +time.toFixed(1)).join(', ')} ms.`)
} finally { await browser.close() }
