import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { zipSync, unzipSync } from 'fflate'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
const chrome = process.env.CROFT_QA_CHROME
const browser = await chromium.launch({ executablePath: chrome, channel: chrome ? undefined : 'chrome', chromiumSandbox: true })
const calculateHash = value => createHash('sha256').update(value).digest('hex')

function toneFile(seconds, rate = 8000, channels = 2) {
  const bytes = Buffer.alloc(44 + seconds * rate * channels * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(rate, 24)
  bytes.writeUInt32LE(rate * channels * 2, 28)
  bytes.writeUInt16LE(channels * 2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  if (seconds < 181) for (let frame = 0; frame < seconds * rate; frame++) {
    const section = Math.floor(frame / (seconds * rate / 4))
    const sample = Math.round(Math.sin(frame * 2 * Math.PI * 211 / rate) * [0, 7200, 20500, 10500][section])
    for (let channel = 0; channel < channels; channel++) bytes.writeInt16LE(channel % 2 ? -sample : sample, 44 + (frame * channels + channel) * 2)
  }
  return bytes
}

function projectFile() {
  const project = createProject('Waveform QA')
  project.camera = { x: 22, y: 32, zoom: 1.25 }
  project.swatches = [{ id: 'test-wave-colour', name: 'Peacock', colour: '#168983cc' }]
  const assets = []
  const files = {}
  const asset = (name, bytes) => {
    const entry = { id: crypto.randomUUID(), mime: 'audio/wav', size: bytes.length, name,
      path: `assets/${String(assets.length).padStart(5, '0')}.bin`, sha256: calculateHash(bytes) }
    assets.push(entry)
    files[entry.path] = bytes
    return entry
  }
  const regular = asset('Synthetic sections.wav', toneFile(16))
  const long = asset('181 seconds.wav', toneFile(181, 8000, 1))
  const invalid = asset('Corrupt audio.wav', Buffer.concat([toneFile(2).subarray(0, 12), Buffer.alloc(120)]))
  const frame = makeObject('frame', { x: 20, y: 100 }, { name: 'Audio frame', width: 580, height: 320 })
  const card = makeObject('audio', { x: 148, y: 172 }, { name: 'Two-sided audio', assetId: regular.id, mode: 'card', parentId: frame.id,
    width: 320, height: 165, rotation: 18, back: { title: 'Reverse audio', text: 'Separate appearance', assetId: regular.id } })
  const peer = makeObject('note', { x: 465, y: 305 }, { name: 'Stack companion', width: 115, height: 90, parentId: frame.id })
  const copy = makeObject('audio', { x: 640, y: 145 }, { name: 'Direct shared audio', assetId: regular.id, mode: 'direct', width: 280, height: 108 })
  project.objects = [frame, card, peer, copy,
    makeObject('audio', { x: 635, y: 305 }, { name: 'Long audio', assetId: long.id }),
    makeObject('audio', { x: 635, y: 450 }, { name: 'Corrupt audio', assetId: invalid.id })]
  files['manifest.json'] = new TextEncoder().encode(JSON.stringify({ format: 'croft-icanvas', version: 4, projects: [project], assets }))
  return { bytes: Buffer.from(zipSync(files, { level: 0 })), sha: regular.sha256 }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2, acceptDownloads: true, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    window.qaDecodeCount = 0
    window.qaWaveBar = null
    const roundRect = CanvasRenderingContext2D.prototype.roundRect
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, width, height, radius) {
      if (this.canvas.getRootNode().host?.closest('.ic-audio-wave-render') && height > width) {
        window.qaWaveBar = { width, radius }
      }
      return roundRect.call(this, x, y, width, height, radius)
    }
    const decode = BaseAudioContext.prototype.decodeAudioData
    BaseAudioContext.prototype.decodeAudioData = function (...args) {
      window.qaDecodeCount++
      return decode.apply(this, args)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(12_000)
  const requests = []
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) requests.push(request.url()) })
  const button = name => page.getByRole('button', { name, exact: true })
  const item = name => page.locator(`.ic-item[aria-label="${name}"]`)
  const toolbar = page.getByRole('toolbar', { name: 'Selection actions' })
  const inspector = page.getByRole('complementary', { name: 'Canvas inspector' })
  const audioInspector = inspector.locator('.ic-audio-properties')
  const display = audioInspector.getByLabel('Audio display')
  const audio = track => track.locator('audio')
  const waveform = track => track.getByRole('slider', { name: 'Seek waveform', exact: true })
  const native = track => audio(track).evaluate(media => ({ time: media.currentTime, duration: media.duration, paused: media.paused }))
  const save = async () => { await page.keyboard.press('Control+s'); await button('Save menu').getByText('Saved', { exact: true }).waitFor() }
  const projectId = () => page.evaluate(() => location.hash.split('/')[1])
  const state = async (id = undefined) => page.evaluate(async project => {
    const request = input => new Promise((resolve, reject) => { input.onsuccess = () => resolve(input.result); input.onerror = () => reject(input.error) })
    const db = await request(indexedDB.open('croft-icanvas'))
    try { return await request(db.transaction('projects').objectStore('projects').get(project || location.hash.split('/')[1])) }
    finally { db.close() }
  }, id)
  const object = (stored, name) => stored.objects.find(item => item.name === name)
  const select = async track => {
    const point = await track.evaluate(node => {
      const box = node.getBoundingClientRect()
      const rotation = new DOMMatrix(getComputedStyle(node).transform)
      const zoom = new DOMMatrix(getComputedStyle(node.closest('.ic-world')).transform).a
      const distance = (node.clientHeight / 2 - 13) * zoom
      return { x: box.x + box.width / 2 + rotation.b * distance, y: box.y + box.height / 2 - rotation.a * distance }
    })
    await page.mouse.click(point.x, point.y)
  }
  const uiPlay = track => track.getByRole('button', { name: 'Play audio', exact: true }).click()
  const uiPause = track => track.getByRole('button', { name: 'Pause audio', exact: true }).click()
  const coordinates = (target, fraction) => target.evaluate((node, ratio) => {
    const item = node.closest('.ic-item')
    const world = node.closest('.ic-world')
    const matrix = new DOMMatrix(getComputedStyle(world).transform)
    const halfStep = (node.clientWidth * (ratio - .5)) * matrix.a
    const box = node.getBoundingClientRect()
    const rotation = new DOMMatrix(getComputedStyle(item).transform)
    return { x: box.x + box.width / 2 + rotation.a * halfStep, y: box.y + box.height / 2 + rotation.b * halfStep }
  }, fraction)

  const fixture = projectFile()
  await page.goto(origin)
  const home = page.getByRole('region', { name: 'Canvas projects' })
  await home.locator('input[accept=".croft,.zip"]').setInputFiles({ name: 'waveform-qa.croft', mimeType: 'application/zip', buffer: fixture.bytes })
  await home.getByRole('button', { name: /^Waveform QA/ }).click()
  const id = await projectId()
  const card = item('Two-sided audio')
  const direct = item('Direct shared audio')
  await waveform(card).waitFor()
  await waveform(direct).waitFor()
  await page.waitForFunction(() => window.qaWaveBar)
  const waveBar = await page.evaluate(() => window.qaWaveBar)
  assert.ok(waveBar.radius > 0 && waveBar.radius === waveBar.width / 2, 'Waveform bars should have round caps at 2× device scale')
  assert.equal(await page.evaluate(() => window.qaDecodeCount), 1, 'Shared source decoded more than once or over-limit source decoded')
  assert.equal(await button('Undo').isDisabled(), true)
  assert.equal(await audio(card).count(), 1)
  assert.equal((await native(card)).duration, 16)
  await item('Long audio').getByText(/tracks up to 3 minutes/i).waitFor()
  assert.equal(await item('Long audio').getByRole('slider', { name: 'Seek audio', exact: true }).count(), 1)
  await item('Corrupt audio').getByText(/damaged or unsupported/).waitFor()

  const initialPosition = await card.evaluate(node => [node.style.left, node.style.top, node.style.transform])
  for (const fraction of [.25, .5, .75]) {
    const point = await coordinates(waveform(card), fraction)
    const diagnostic = await waveform(card).evaluate((node, point) => ({point, rect: node.getBoundingClientRect().toJSON(),
      targets: document.elementsFromPoint(point.x, point.y).slice(0, 5).map(element => `${element.tagName} ${element.className} ${element.getAttribute('aria-label')}`),
      transform: getComputedStyle(node.closest('.ic-item')).transform, world: getComputedStyle(node.closest('.ic-world')).transform}), point)
    await page.mouse.click(point.x, point.y)
    const actual = (await native(card)).time
    assert.ok(Math.abs(actual - 16 * fraction) < .2, `Seek at ${fraction} resulted in ${actual}s. Hit ${JSON.stringify(diagnostic)}`)
  }
  const start = await coordinates(waveform(card), .3)
  const end = await coordinates(waveform(card), .7)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()
  assert.ok(Math.abs((await native(card)).time - 11.2) < .2)
  await waveform(card).evaluate(node => {
    node.addEventListener('pointerdown', event => { node.dataset.qaPointer = String(event.pointerId) }, { once: true })
  })
  const priorSeek = (await native(card)).time
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await waveform(card).evaluate(node => {
    node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: Number(node.dataset.qaPointer), bubbles: true }))
  })
  await page.mouse.up()
  assert.ok(Math.abs((await native(card)).time - priorSeek) < .05, 'Pointer cancellation did not restore the seek position')
  assert.deepEqual(await card.evaluate(node => [node.style.left, node.style.top, node.style.transform]), initialPosition)
  await waveform(card).press('Home')
  assert.equal((await native(card)).time, 0)
  await waveform(card).press('Space')
  await page.waitForFunction(() => document.querySelector('[aria-label="Two-sided audio"] audio').currentTime > .15)
  await waveform(card).press('Space')
  assert.equal((await native(card)).paused, true)
  await card.getByRole('button', { name: 'Mute audio', exact: true }).click()
  assert.equal(await audio(card).evaluate(media => media.muted), true)
  await card.getByRole('button', { name: 'Unmute audio', exact: true }).click()
  const volume = card.getByRole('slider', { name: 'Audio volume', exact: true })
  await page.waitForFunction(() => document.querySelector('[aria-label="Two-sided audio"] .ic-audio-volume').valueAsNumber === 1)
  await volume.press('ArrowLeft')
  await page.waitForFunction(() => Math.abs(document.querySelector('[aria-label="Two-sided audio"] audio').volume - .95) < .001)
  assert.equal(await button('Undo').isDisabled(), true, 'Playback or seeking entered undo history')

  await select(card)
  await audioInspector.waitFor()
  const waveColour = audioInspector.getByRole('group', { name: 'Waveform colour', exact: true })
  const progress = audioInspector.getByRole('group', { name: 'Progress colour', exact: true })
  const renderedBase = card.locator('[part="canvases"] canvas').first()
  const bitmap = await renderedBase.evaluate(canvas => canvas.toDataURL())
  await uiPlay(card)
  const beforeAppearance = (await native(card)).time
  await waveColour.getByRole('button', { name: 'Use swatch Peacock' }).click()
  await page.waitForFunction(previous => {
    const layer = document.querySelector('[aria-label="Two-sided audio"] .ic-audio-wave-render > div')?.shadowRoot
    const canvas = layer?.querySelector('[part="canvases"] canvas')
    return canvas && canvas.toDataURL() !== previous
  }, bitmap)
  await progress.getByRole('button', { name: 'Custom colour', exact: true }).click()
  await progress.getByLabel('HEX', { exact: true }).fill('#f04c4780')
  await progress.getByRole('button', { name: 'Apply colour', exact: true }).click()
  assert.equal((await native(card)).paused, false)
  await display.selectOption('compact')
  await card.getByRole('slider', { name: 'Seek audio', exact: true }).waitFor()
  assert.equal((await native(card)).paused, false)
  await display.selectOption('waveform')
  await waveform(card).waitFor()
  assert.equal((await native(card)).paused, false)
  const dimensions = inspector.getByLabel('Width', { exact: true })
  await dimensions.fill('350')
  await dimensions.press('Enter')
  assert.equal((await native(card)).paused, false)
  assert.ok((await native(card)).time >= beforeAppearance)
  assert.equal(await page.evaluate(() => window.qaDecodeCount), 1)
  await uiPause(card)
  await audioInspector.getByText('Playhead', { exact: true }).click()
  const playhead = audioInspector.getByRole('group', { name: 'Playhead colour', exact: true })
  await playhead.getByRole('button', { name: 'Use swatch Peacock' }).click()
  await button('Undo').click()
  assert.equal(await playhead.getByRole('button', { name: 'Use swatch Peacock' }).getAttribute('aria-pressed'), 'false')
  await button('Redo').click()
  assert.equal(await playhead.getByRole('button', { name: 'Use swatch Peacock' }).getAttribute('aria-pressed'), 'true')

  await uiPlay(card)
  await audio(card).evaluate(media => { window.qaPreviousAudio = media })
  await card.getByRole('button', { name: 'Show back of card', exact: true }).press('Enter')
  await waveform(card).waitFor()
  assert.equal(await page.evaluate(() => window.qaPreviousAudio.paused && !window.qaPreviousAudio.isConnected), true)
  assert.equal((await native(card)).paused, true)
  await display.selectOption('compact')
  await audioInspector.locator('[aria-label="Waveform colour"] button[aria-label="Select colour #eddcf5"]').click()
  await save()
  const saved = object(await state(id), 'Two-sided audio')
  assert.deepEqual(saved.audioAppearance, { mode: 'waveform', waveColour: '#168983cc', progressColour: '#f04c4780', playheadColour: '#168983cc' })
  assert.deepEqual(saved.back.audioAppearance, { mode: 'compact', waveColour: '#eddcf5' })
  assert.equal(object(await state(id), 'Direct shared audio').audioAppearance, undefined)

  await item('Stack companion').click({ modifiers: ['Shift'] })
  await toolbar.getByRole('button', { name: 'Stack Cards', exact: true }).click()
  const count = button('Browse 2 cards in Card stack')
  await count.waitFor()
  assert.equal(await audio(card).count(), 0)
  const pile = page.locator('.ic-stack-member-popover')
  await count.click()
  await pile.getByRole('button', { name: 'Two-sided audio', exact: true }).click()
  await card.getByRole('slider', { name: 'Seek audio', exact: true }).waitFor()
  await count.click()
  await pile.getByRole('button', { name: 'Fan Out', exact: true }).click()
  await count.click()
  await pile.getByRole('button', { name: 'Restack', exact: true }).click()
  await count.click()
  await pile.getByRole('button', { name: 'Unstack All', exact: true }).click()
  await count.waitFor({ state: 'hidden' })
  await save()
  assert.deepEqual(object(await state(id), 'Two-sided audio').back.audioAppearance, saved.back.audioAppearance)
  assert.equal(await page.evaluate(() => window.qaDecodeCount), 1)

  await uiPlay(card)
  await audio(card).evaluate(media => { window.qaFoldedAudio = media })
  await item('Audio frame').locator('.ic-frame-label').click()
  await inspector.getByRole('checkbox', { name: 'Collapse frame' }).check()
  await audio(card).waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.qaFoldedAudio.paused), true)
  await inspector.getByRole('checkbox', { name: 'Collapse frame' }).uncheck()
  await audio(card).waitFor({ state: 'attached' })
  assert.equal((await native(card)).paused, true)

  await button('Save menu').click()
  await button('Save VC').click()
  const checkpoint = page.getByRole('dialog', { name: 'Save VC' })
  await checkpoint.getByLabel('Version notes (optional)').fill('Audio appearance checkpoint')
  await checkpoint.getByRole('button', { name: 'Save version', exact: true }).click()
  await checkpoint.waitFor({ state: 'hidden' })
  await select(card)
  await audioInspector.getByRole('button', { name: 'Reset Appearance' }).click()
  await save()
  assert.equal(object(await state(id), 'Two-sided audio').back.audioAppearance, undefined)
  await button('Project menu').click()
  await button('Version History').click()
  const history = page.getByRole('dialog', { name: 'Version history' })
  await history.getByRole('button', { name: /v1.*Audio appearance checkpoint/ }).click()
  await history.getByRole('button', { name: 'Restore…', exact: true }).click()
  await history.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await history.waitFor({ state: 'hidden' })
  assert.deepEqual(object(await state(id), 'Two-sided audio').back.audioAppearance, saved.back.audioAppearance)

  const reader = await context.newPage()
  await reader.goto(page.url())
  await reader.getByRole('button', { name: 'Enable editing', exact: true }).waitFor()
  const readonly = reader.locator('.ic-item[aria-label="Two-sided audio"]')
  await readonly.getByRole('button', { name: 'Play audio', exact: true }).click()
  await readonly.getByRole('button', { name: 'Pause audio', exact: true }).click()
  assert.equal(await reader.getByLabel('Audio display').count(), 0)
  await reader.close()

  await page.reload()
  await card.getByRole('slider', { name: 'Seek audio', exact: true }).waitFor()
  assert.equal((await native(card)).paused, true)
  await uiPlay(card)
  await audio(card).evaluate(media => { window.qaDeletedAudio = media })
  await select(card)
  await toolbar.getByRole('button', { name: 'Delete selected', exact: true }).click()
  await audio(card).waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.qaDeletedAudio.paused && !window.qaDeletedAudio.src), true)
  await button('Undo').click()
  await audio(card).waitFor({ state: 'attached' })
  assert.equal((await native(card)).paused, true)
  await button('Project menu').click()
  await button('Export').click()
  const exportDialog = page.getByRole('dialog', { name: 'Export canvas' })
  const downloading = page.waitForEvent('download')
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click()
  const file = await downloading
  const entries = unzipSync(await readFile(await file.path()))
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'))
  assert.equal(manifest.version, 4)
  const source = manifest.assets.find(asset => asset.name === 'Synthetic sections.wav')
  assert.equal(calculateHash(entries[source.path]), fixture.sha)
  assert.deepEqual(requests, [])
  assert.deepEqual(errors, [])
  console.log(`Chrome ${browser.version()} verified 16 s opposite-phase stereo WAV, one shared decode, 25/50/75% transformed seek within 0.2 s, drag/cancel and keyboard, playback continuity, RGBA/swatches, independent Back, stacks, frame/deletion pause, Save VC, read-only, reload and original SHA-256. Long and corrupt files provided honest fallbacks.`)
} finally {
  await browser.close()
}
