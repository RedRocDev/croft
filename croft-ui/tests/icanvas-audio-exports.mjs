import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'

const [playwrightPath, chromePath, origin = 'http://localhost:5173'] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide Playwright and Chrome paths.')
const address = new URL(origin)
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const template = createProject('Waveform export fixture')
const back = createProject('Back export fixture')
const missing = createProject('Missing audio fixture')
const source = { id: 'wave-export', name: 'Generated chime.wav', mime: 'audio/wav' }
const unavailable = { id: 'wave-missing', name: 'Unavailable original.wav', mime: source.mime, linked: true, size: 200 }
const frontStyle = { mode: 'waveform', waveColour: '#ad51e1', progressColour: '#591740', playheadColour: '#16a867' }
const backStyle = { mode: 'compact', waveColour: '#315abc', progressColour: '#ff9911', playheadColour: '#a7432f77' }
const card = makeObject('audio', { x: 50, y: 70 }, { name: source.name, assetId: source.id, mode: 'direct', width: 380, height: 115, audioAppearance: frontStyle })
const doubleSided = makeObject('audio', { x: 50, y: 70 }, { name: source.name, assetId: source.id, mode: 'card', width: 380, height: 205,
  audioAppearance: frontStyle, visibleSide: 'back', back: { title: 'Audio on reverse', text: 'Local recording', assetId: source.id, audioAppearance: backStyle } })
template.objects = [card]
back.objects = [doubleSided]
missing.objects = [makeObject('audio', { x: 50, y: 70 }, { name: unavailable.name, assetId: unavailable.id, audioAppearance: frontStyle })]

function makeWave() {
  const rate = 8000
  const frames = rate * 4
  const bytes = Buffer.alloc(44 + frames * 4)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22)
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  for (let i = 0; i < frames; i++) {
    const second = i / rate
    const gain = second < 1 ? 0 : second < 2 ? .25 : second < 3 ? .8 : 0
    const volume = second > 3.25 && second < 3.251 ? 30_000 : Math.round(32_000 * gain * Math.sin(i * Math.PI / 10))
    bytes.writeInt16LE(volume, 44 + i * 4)
    bytes.writeInt16LE(-volume, 46 + i * 4)
  }
  return bytes
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, acceptDownloads: true, reducedMotion: 'reduce' })
  const errors = []
  const network = []
  page.setDefaultTimeout(15_000)
  await page.clock.install()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) network.push(request.url())
  })
  await page.goto(origin)
  await page.locator('.ic-project-open').first().waitFor()
  const bytes = makeWave()
  await page.evaluate(async ({ projects, source, unavailable, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const blob = new Blob([bytes], { type: source.mime })
    // This test seeds a disposable workspace directly so it can run against the built app.
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('croft-icanvas')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['projects', 'assets'], 'readwrite')
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
        for (const project of projects) tx.objectStore('projects').put(project)
        tx.objectStore('assets').put({ ...source, blob, size: blob.size })
        tx.objectStore('assets').put(unavailable)
      })
    } finally { db.close() }
  }, { projects: [template, back, missing], source, unavailable, base64: bytes.toString('base64') })

  async function openCanvas(project) {
    await page.goto(`${address.origin}/?qa=audiowaveform#canvas/${project.id}`)
    await page.getByRole('region', { name: 'Canvas', exact: true }).waitFor()
  }
  async function download(format, background = undefined) {
    await page.getByRole('button', { name: 'Project menu' }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export canvas' })
    await dialog.getByLabel('Format').selectOption(format)
    await dialog.getByLabel('Scope').selectOption('canvas')
    if (background) await dialog.getByLabel('Background').selectOption(background)
    const [result] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export', exact: true }).click()])
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await result.failure(), null)
    return readFile(await result.path())
  }
  const imageSamples = (bytes, mime, points) => page.evaluate(async ({ src, points }) => {
    const image = new Image()
    image.src = src
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    return { size: [canvas.width, canvas.height], samples: points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]) }
  }, { src: `data:${mime};base64,${bytes.toString('base64')}`, points })

  await openCanvas(template)
  const svg = await download('svg', 'transparent')
  const markup = svg.toString()
  assert.match(markup, /data-audio-waveform="unplayed" data-audio-duration="4"/)
  assert.match(markup, /Generated chime\.wav/)
  assert.match(markup, /0:04/)
  assert.doesNotMatch(markup, /data:audio|<audio|<controls/)
  const path = markup.match(/<path d="([M\d .V]+)" fill="none" stroke="#ad51e1"/)?.[1]
  assert.ok(path)
  const bars = [...path.matchAll(/M([\d.]+) ([\d.]+)V([\d.]+)/g)].map(match => match.slice(1).map(Number))
  assert.ok(bars.length < 57 && bars.length > 45, `Half the visible bins carry audio plus a transient: ${bars.length}`)
  assert.ok(bars[0][0] > 95, 'A full second of silence creates no bars')
  const loud = bars.find(([x]) => x > 213 && x < 231)
  assert.ok(loud[2] - loud[1] > (bars[0][2] - bars[0][1]) * 2.5)
  assert.ok(bars.at(-1)[0] > 300 && bars.at(-1)[0] < 320, 'A brief late transient remains visible')
  assert.match(markup, /stroke="#16a867"/)
  assert.doesNotMatch(markup, /#591740|Waveform unavailable/, 'A static waveform paints no progress at time zero')
  const [left, top] = markup.match(/viewBox="([^ ]+) ([^ ]+) /).slice(1).map(Number)
  const solid = [50 - left + Math.round(loud[0]), 70 - top + Math.round((loud[1] + loud[2]) / 2)]
  const points = [solid, [0, 0]]
  const vector = await imageSamples(svg, 'image/svg+xml', points)
  assert.ok(vector.samples[0][0] > 140 && vector.samples[0][2] > 180)
  assert.equal(vector.samples[1][3], 0)
  assert.deepEqual(await imageSamples(await download('png', 'transparent'), 'image/png', points), vector)
  const jpeg = await download('jpg', 'clean')
  const raster = await imageSamples(jpeg, 'image/jpeg', points)
  assert.deepEqual(raster.size, vector.size)
  assert.ok(raster.samples[0][2] - raster.samples[0][1] > 45, `Expected a purple JPEG bar, got ${raster.samples[0]}`)
  assert.equal(raster.samples[1][3], 255)
  const pdf = await download('pdf', 'clean')
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-1\.4/)
  assert.ok(pdf.includes(jpeg))

  await openCanvas(back)
  const reverse = (await download('svg')).toString()
  assert.match(reverse, /Audio on reverse/)
  assert.match(reverse, /data-audio-waveform="unplayed"/)
  assert.match(reverse, /stroke="#315abc"/)
  assert.doesNotMatch(reverse, /stroke="#ad51e1"/)
  for (const format of ['croft', 'zip']) {
    const archive = unzipSync(await download(format))
    const manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString())
    assert.equal(manifest.version, 4)
    assert.deepEqual(manifest.projects[0].objects[0].audioAppearance, frontStyle)
    assert.deepEqual(manifest.projects[0].objects[0].back.audioAppearance, backStyle)
    assert.equal(manifest.assets.length, 1)
    assert.equal(digest(archive[manifest.assets[0].path]), digest(bytes))
  }
  await openCanvas(missing)
  const absent = (await download('svg')).toString()
  assert.match(absent, /Waveform unavailable/)
  assert.doesNotMatch(absent, /data-audio-waveform="unplayed"/)

  function readDraft(projectId) {
    return page.evaluate(async id => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('croft-icanvas')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('projects').objectStore('projects').get(id)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      } finally { db.close() }
    }, projectId)
  }

  await openCanvas(back)
  const button = name => page.getByRole('button', { name, exact: true })
  const audioCard = id => page.getByTestId(`canvas-object-${id}`)
  const selectAudio = id => audioCard(id).click({ position: { x: 18, y: 13 } })
  const mode = page.getByRole('combobox', { name: 'Audio display' })
  const assertSaved = () => button('Save menu').getByText('Saved', { exact: true }).waitFor()
  await selectAudio(doubleSided.id)
  assert.equal(await mode.inputValue(), 'compact')
  await page.evaluate(id => {
    const put = IDBObjectStore.prototype.put
    window.clearInjectedQuota = () => { IDBObjectStore.prototype.put = put }
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'projects' && value.id === id) throw new DOMException('Synthetic quota error exercising audio settings', 'QuotaExceededError')
      return put.call(this, value, ...args)
    }
  }, back.id)
  await mode.selectOption('waveform')
  await page.keyboard.press('Control+s')
  await button('Save menu').getByText('Save failed', { exact: true }).waitFor()
  assert.equal(await mode.inputValue(), 'waveform')
  assert.equal((await readDraft(back.id)).objects[0].back.audioAppearance.mode, 'compact')
  await page.evaluate(() => window.clearInjectedQuota())
  await button('Retry').first().click()
  await assertSaved()
  assert.equal((await readDraft(back.id)).objects[0].back.audioAppearance.mode, 'waveform')

  // Use the real recovery timer and restore UI. Recovery snapshots are stored separately from normal saves.
  await mode.selectOption('compact')
  await page.clock.fastForward(301_000)
  await page.waitForFunction(async id => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('croft-icanvas')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('recoveries').objectStore('recoveries').index('projectId').getAll(id)
        request.onsuccess = () => resolve(request.result.some(entry => entry.project.objects[0].back.audioAppearance.mode === 'compact'))
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  }, back.id)
  await mode.selectOption('waveform')
  await page.clock.fastForward(2200)
  await assertSaved()
  await button('Project menu').click()
  await button('Recovery snapshots').click()
  const recovery = page.getByRole('dialog', { name: 'Recovery copies' })
  await recovery.getByRole('button', { name: /^Recovery · / }).first().click()
  await recovery.getByRole('button', { name: 'Restore…', exact: true }).click()
  await recovery.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await recovery.waitFor({ state: 'hidden' })
  assert.deepEqual((await readDraft(back.id)).objects[0].back.audioAppearance, backStyle)

  await button('Save menu').click()
  await button('Save As…').click()
  const saveAs = page.getByRole('dialog', { name: 'Save As…' })
  await saveAs.getByLabel('Name', { exact: true }).fill('Independent audio copy')
  await saveAs.getByRole('button', { name: 'Create copy', exact: true }).click()
  await saveAs.waitFor({ state: 'hidden' })
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByText('Independent audio copy', { exact: true }).waitFor()
  const details = page.getByRole('dialog', { name: 'Project Details' })
  if (await details.count()) await details.getByRole('button', { name: 'Cancel', exact: true }).click()
  const copyId = await page.evaluate(() => location.hash.split('/')[1])
  const copy = (await readDraft(copyId)).objects[0]
  assert.notEqual(copy.id, doubleSided.id)
  assert.equal(copy.assetId, source.id)
  assert.deepEqual(copy.audioAppearance, frontStyle)
  assert.deepEqual(copy.back.audioAppearance, backStyle)
  await selectAudio(copy.id)
  await mode.selectOption('waveform')
  await page.clock.fastForward(2200)
  await assertSaved()
  assert.equal((await readDraft(copyId)).objects[0].back.audioAppearance.mode, 'waveform')
  assert.deepEqual((await readDraft(back.id)).objects[0].back.audioAppearance, backStyle)
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [])
  console.log(`Chrome ${browser.version()} at ${origin}: 4-second opposite-phase stereo WAV exported real unplayed SVG/PNG/JPEG/PDF waveform, showing silence, distinct levels and a late transient. Compact Back used its own colours. V4 .croft and .zip preserved audio SHA-256 ${digest(bytes)}. Missing sources produced labelled output. No third-party requests.`)
  console.log('Quota failure kept the editable Back mode and the prior committed copy until Retry succeeded. Timer-created recovery and independent Save As preserved both face settings.')
} finally { await browser.close() }
