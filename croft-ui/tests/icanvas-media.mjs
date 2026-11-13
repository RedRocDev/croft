import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, chromePath, origin = 'http://localhost:5173'] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: chromePath, chromiumSandbox: true })

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  page.setDefaultTimeout(10_000)
  const errors = []
  const network = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(origin).origin) {
      network.push(request.url())
    }
  })
  await page.goto(origin)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).click()
  const canvas = page.getByRole('region', { name: 'Canvas', exact: true })
  await canvas.waitFor()

  const fixtures = await page.evaluateHandle(async () => {
    const source = document.createElement('canvas')
    source.width = 96
    source.height = 64
    const context = source.getContext('2d')
    context.fillStyle = '#356b5c'
    context.fillRect(0, 0, source.width, source.height)
    context.fillStyle = '#f4e3c7'
    context.fillRect(5, 10, 22, 24)
    const png = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('The browser could not create the sample PNG.')

    const frames = 16_000
    const wav = new ArrayBuffer(44 + frames * 2)
    const samples = new DataView(wav)
    function signature(value, offset) {
      for (let index = 0; index < value.length; index++) samples.setUint8(offset + index, value.charCodeAt(index))
    }
    signature('RIFF', 0)
    samples.setUint32(4, wav.byteLength - 8, true)
    signature('WAVEfmt ', 8)
    samples.setUint32(16, 16, true)
    samples.setUint16(20, 1, true)
    samples.setUint16(22, 1, true)
    samples.setUint32(24, 16_000, true)
    samples.setUint32(28, 32_000, true)
    samples.setUint16(32, 2, true)
    samples.setUint16(34, 16, true)
    signature('data', 36)
    samples.setUint32(40, frames * 2, true)
    for (let index = 0; index < frames; index++) {
      const tone = Math.sin(2 * Math.PI * 440 * index / 16_000)
      samples.setInt16(44 + index * 2, tone * 3800, true)
    }

    // Encode four independently decodable VP8 frames and wrap them in a small WebM.
    const concatenate = parts => {
      const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
      let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.length }
      return bytes
    }
    const uint = number => {
      const bytes = []
      do { bytes.unshift(number & 255); number >>>= 8 } while (number > 0)
      return Uint8Array.from(bytes)
    }
    const element = (id, content) => {
      const length = content.length
      let width = 1
      while (length >= 2 ** (width * 7) - 1) width++
      const size = uint(length)
      const encoded = new Uint8Array(width)
      encoded.set(size, width - size.length)
      encoded[0] |= 1 << (8 - width)
      return concatenate([uint(id), encoded, content])
    }
    const container = (id, ...parts) => element(id, concatenate(parts))
    const number = (id, value) => element(id, uint(value))
    const string = (id, value) => element(id, new TextEncoder().encode(value))
    const videoFrames = []
    for (let frame = 0; frame < 4; frame++) {
      context.fillStyle = '#356b5c'
      context.fillRect(0, 0, source.width, source.height)
      context.fillStyle = '#f4e3c7'
      context.fillRect(5 + frame * 18, 18, 22, 24)
      const webp = await new Promise(resolve => source.toBlob(resolve, 'image/webp', .8))
      const bytes = new Uint8Array(await webp.arrayBuffer())
      const view = new DataView(bytes.buffer)
      const decoder = new TextDecoder()
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const label = decoder.decode(bytes.subarray(offset, offset + 4))
        const length = view.getUint32(offset + 4, true)
        if (label === 'VP8 ') {
          const time = frame * 200
          videoFrames.push(element(0xa3, concatenate([
            Uint8Array.of(0x81, time >> 8, time & 255, 0x80), bytes.subarray(offset + 8, offset + 8 + length),
          ])))
          break
        }
        offset += 8 + length + (length % 2)
      }
    }
    if (videoFrames.length !== 4) throw new Error('The browser could not encode the sample VP8 frames.')
    const duration = new DataView(new ArrayBuffer(8))
    duration.setFloat64(0, 800)
    const ebml = container(0x1a45dfa3, number(0x4286, 1), number(0x42f7, 1), number(0x42f2, 4), number(0x42f3, 8),
      string(0x4282, 'webm'), number(0x4287, 2), number(0x4285, 2))
    const info = container(0x1549a966, number(0x2ad7b1, 1_000_000), string(0x4d80, 'Croft tests'), string(0x5741, 'Croft tests'),
      element(0x4489, new Uint8Array(duration.buffer)))
    const tracks = container(0x1654ae6b, container(0xae, number(0xd7, 1), number(0x73c5, 1), number(0x83, 1),
      string(0x86, 'V_VP8'), number(0x23e383, 200_000_000), container(0xe0, number(0xb0, 96), number(0xba, 64))))
    const cluster = container(0x1f43b675, number(0xe7, 0), ...videoFrames)
    const recorded = [ebml, container(0x18538067, info, tracks, cluster)]
    const direct = document.createElement('video')
    direct.muted = true
    const directUrl = URL.createObjectURL(new Blob(recorded, { type: 'video/webm' }))
    direct.src = directUrl
    try {
      await direct.play()
    } catch (error) {
      throw new Error(`Generated WebM cannot play directly: ${error.message}; ${direct.error?.message}`)
    } finally {
      direct.pause()
      URL.revokeObjectURL(directUrl)
    }
    return { png, wav, recorded }
  })

  async function importBatch(prefix, includeVideo) {
    const transfer = await page.evaluateHandle(({ fixtures, prefix, includeVideo }) => {
      const result = new DataTransfer()
      result.items.add(new File([fixtures.png], prefix + ' sample.png', { type: 'image/png' }))
      result.items.add(new File([fixtures.wav], prefix + ' tone.wav', { type: 'audio/wav' }))
      if (includeVideo) result.items.add(new File(fixtures.recorded, prefix + ' motion.webm', { type: 'video/webm' }))
      return result
    }, { fixtures, prefix, includeVideo })
    const bounds = await canvas.boundingBox()
    assert.ok(bounds)
    await canvas.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientX: bounds.x + bounds.width * .35 + 9,
      clientY: bounds.y + bounds.height * .29 + 13,
    })
    const dialog = page.getByRole('dialog', { name: 'Add files' })
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await transfer.dispose()
  }

  await importBatch('Smart', true)
  await page.getByRole('button', { name: 'Toolbar options' }).click()
  await page.getByRole('button', { name: 'Free placement' }).click()
  await importBatch('Free', false)
  await page.getByRole('button', { name: 'Fit All', exact: true }).click()
  await page.keyboard.press('Control+s')

  const readSaved = () => page.evaluate(async () => {
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await read(indexedDB.open('croft-icanvas'))
    const id = location.hash.split('/')[1]
    try {
      const project = await read(db.transaction('projects').objectStore('projects').get(id))
      const fixtures = project.objects.filter(item => /^(Smart|Free) /.test(item.name))
      const assets = db.transaction('assets').objectStore('assets')
      return await Promise.all(fixtures.map(async ({ name, kind, x, y, assetId }) => {
        const asset = await read(assets.get(assetId))
        return { name, kind, x, y, mime: asset?.blob?.type, bytes: asset?.blob?.size }
      }))
    } finally {
      db.close()
    }
  })
  const saved = await readSaved()
  assert.deepEqual(saved.map(file => [file.kind, file.mime]), [
    ['image', 'image/png'], ['audio', 'audio/wav'], ['video', 'video/webm'], ['image', 'image/png'], ['audio', 'audio/wav'],
  ])
  assert.ok(saved.every(file => file.bytes > 0))
  assert.equal(saved[0].x % 24, 0)
  assert.equal(saved[1].x - saved[0].x, 306)
  assert.equal(saved[2].x - saved[1].x, 306)
  assert.equal(saved[4].x - saved[3].x, 24)
  assert.equal(saved[4].y - saved[3].y, 16)

  async function checkDecodedMedia() {
    const image = canvas.getByRole('img', { name: 'Smart sample.png', exact: true })
    await image.waitFor()
    await image.evaluate(async node => await node.decode())
    assert.deepEqual(await image.evaluate(node => [node.naturalWidth, node.naturalHeight]), [96, 64])
    for (const [selector, name] of [['audio', 'Smart tone.wav'], ['video', 'Smart motion.webm']]) {
      const media = canvas.locator(`${selector}[aria-label="${name}"]`)
      await media.waitFor()
      const playback = await media.evaluate(async node => {
        node.muted = true
        const video = node instanceof HTMLVideoElement
        let frame
        if (video) frame = new Promise(resolve => node.requestVideoFrameCallback((_, metadata) => resolve(metadata.presentedFrames)))
        try {
          await node.play()
        } catch (error) {
          const blob = await fetch(node.currentSrc || node.src).then(response => response.blob()).catch(() => undefined)
          throw new Error(`${node.getAttribute('aria-label')}: ${error.message}; blob ${blob?.type}, ${blob?.size} bytes; ${node.error?.message}`)
        }
        const result = await Promise.race([
          (async () => {
            const presented = frame ? await frame : 0
            while (node.currentTime < .15 && !node.ended) await new Promise(resolve => setTimeout(resolve, 20))
            return { currentTime: node.currentTime, frame: presented, error: node.error?.message, dimensions: video ? [node.videoWidth, node.videoHeight] : [] }
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Media playback did not advance.')), 4000)),
        ])
        node.pause()
        return result
      })
      assert.ok(playback.currentTime >= .15)
      assert.equal(playback.error, undefined)
      if (selector === 'video') {
        assert.ok(playback.frame >= 1)
        assert.deepEqual(playback.dimensions, [96, 64])
      }
    }
  }

  await checkDecodedMedia()
  await page.reload()
  await canvas.waitFor()
  await page.getByRole('button', { name: 'Fit All', exact: true }).click()
  assert.deepEqual(await readSaved(), saved)
  await checkDecodedMedia()
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [])
  console.log(`Chrome ${browser.version()}: PNG decoded, WAV played and WebM played with rendered frames before and after reload. Smart/Free batch positions persisted. Zero page errors, console errors, or external HTTP requests.`)
} finally {
  await browser.close()
}
