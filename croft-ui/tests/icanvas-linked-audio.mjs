import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173')
assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
const temp = resolve(tmpdir())
const testRoot = resolve(fileURLToPath(new URL('../node_modules/.cache/', import.meta.url)))
await mkdir(testRoot, { recursive: true })
const workspace = await mkdtemp(join(testRoot, 'croft-linked-audio-'))
const profile = await mkdtemp(join(temp, 'croft-linked-audio-profile-'))
const originalName = 'Synthetic linked recording.wav'
const sourcePath = join(workspace, originalName)
const movedPath = join(workspace, 'Temporarily moved recording.wav')
const replacementPath = join(workspace, 'Synthetic replacement recording.wav')
const chrome = process.env.CROFT_QA_CHROME
const errors = []
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
let browser
let page

function wave(seconds, frequency) {
  const rate = 8000
  const frames = rate * seconds
  const pcm = Buffer.alloc(44 + frames * 2)
  pcm.write('RIFF', 0)
  pcm.writeUInt32LE(pcm.length - 8, 4)
  pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16)
  pcm.writeUInt16LE(1, 20)
  pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(rate, 24)
  pcm.writeUInt32LE(rate * 2, 28)
  pcm.writeUInt16LE(2, 32)
  pcm.writeUInt16LE(16, 34)
  pcm.write('data', 36)
  pcm.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / rate * frequency * Math.PI * 2)), 44 + i * 2)
  return pcm
}

async function launch(url = origin.href) {
  browser = await chromium.launchPersistentContext(profile, {
    ...(chrome ? { executablePath: chrome } : { channel: 'chrome' }),
    headless: true, chromiumSandbox: true, viewport: { width: 1440, height: 900 },
  })
  page = browser.pages()[0] ?? await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin.origin) errors.push(request.url())
  })
  await page.goto(url)
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const stage = () => page.getByRole('region', { name: 'Canvas', exact: true })
const item = () => stage().locator(`.ic-item[aria-label="${originalName}"]`)
const seek = () => item().getByRole('slider', { name: 'Seek waveform', exact: true })

async function openCanvas() {
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).click()
  await stage().waitFor()
}

async function dropRealFile(path) {
  const area = await stage().boundingBox()
  assert.ok(area)
  const client = await browser.newCDPSession(page)
  try {
    const data = { items: [], files: [path], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await client.send('Input.dispatchDragEvent', { type, x: area.x + 260, y: area.y + 320, data })
    }
  } finally { await client.detach() }
}

async function state() {
  return page.evaluate(async name => {
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await read(indexedDB.open('croft-icanvas'))
    try {
      const transaction = db.transaction(['projects', 'assets'])
      const project = await read(transaction.objectStore('projects').get(location.hash.split('/')[1]))
      const object = project.objects.find(candidate => candidate.name === name)
      const asset = await read(transaction.objectStore('assets').get(object.assetId))
      return { id: object.id, assetId: asset.id, appearance: object.audioAppearance, asset: asset.name,
        native: asset.handle instanceof FileSystemFileHandle, linked: asset.linked, copied: !!asset.blob,
        permission: await asset.handle?.queryPermission({ mode: 'read' }) }
    } finally { db.close() }
  }, originalName)
}

async function save() {
  await page.keyboard.press('Control+s')
  await button(page, 'Save menu').getByText('Saved', { exact: true }).waitFor()
}

try {
  const source = wave(2, 220)
  const replacement = wave(3, 440)
  await writeFile(sourcePath, source, { flag: 'wx' })
  await writeFile(replacementPath, replacement, { flag: 'wx' })
  await launch()
  await openCanvas()
  await dropRealFile(sourcePath)
  const add = page.getByRole('dialog', { name: 'Add files', exact: true })
  await button(add, 'Link In').click()
  await button(add, 'Add').click()
  await add.waitFor({ state: 'hidden' })
  await button(page, 'Fit All').click()
  await seek().waitFor()
  assert.equal(Number(await seek().getAttribute('aria-valuemax')), 2)
  await item().locator('.ic-object-title').click()
  const waveColour = page.getByRole('group', { name: 'Waveform colour', exact: true })
  await button(waveColour, 'Select colour #f5e7a5').click()
  await save()
  const saved = await state()
  assert.deepEqual(saved.appearance, { mode: 'waveform', waveColour: '#f5e7a5' })
  assert.equal(saved.native, true)
  assert.equal(saved.linked, true)
  assert.equal(saved.copied, false)
  assert.equal(saved.permission, 'granted')

  await rename(sourcePath, movedPath)
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByRole('button', { name: 'Home', exact: true }).click()
  await openCanvas()
  await item().getByText('File missing or moved', { exact: true }).waitFor()
  assert.equal(await seek().count(), 0, 'A cached waveform must not imply that a missing source can play.')
  assert.deepEqual(await state(), saved)
  await rename(movedPath, sourcePath)
  await button(item(), 'Check again').click()
  await seek().waitFor()

  const reopenedUrl = page.url()
  await browser.close()
  browser = undefined
  await launch(reopenedUrl)
  await stage().waitFor()
  const reopened = await state()
  assert.deepEqual({ ...reopened, permission: saved.permission }, saved)
  if (reopened.permission !== 'granted') await button(item(), 'Restore access').waitFor()
  else await seek().waitFor()

  await page.evaluate(name => {
    const { queryPermission, requestPermission } = FileSystemHandle.prototype
    FileSystemHandle.prototype.queryPermission = function (options) {
      return this.name === name ? Promise.resolve('denied') : queryPermission.call(this, options)
    }
    FileSystemHandle.prototype.requestPermission = function (options) {
      if (this.name !== name) return requestPermission.call(this, options)
      if (options.mode !== 'read') throw new Error('Croft requested write permission for a linked recording.')
      return Promise.resolve('denied')
    }
    window.dispatchEvent(new Event('focus'))
  }, originalName)
  await item().getByText('File access denied', { exact: true }).waitFor()
  await button(item(), 'Restore access').press('Enter')
  assert.equal(await seek().count(), 0)
  assert.deepEqual(await state(), { ...saved, permission: 'denied' })

  await page.evaluate(() => {
    document.addEventListener('drop', event => {
      event.preventDefault()
      event.stopImmediatePropagation()
      window.croftReplacementHandle = event.dataTransfer.items[0].getAsFileSystemHandle()
    }, { capture: true, once: true })
  })
  await dropRealFile(replacementPath)
  await page.evaluate(async () => {
    const handle = await window.croftReplacementHandle
    if (!(handle instanceof FileSystemFileHandle)) throw new Error('Expected Chrome to supply a genuine host-file handle.')
    window.showOpenFilePicker = async ({ multiple }) => {
      if (multiple) throw new Error('Expected a single replacement file.')
      return [handle]
    }
  })
  await button(item(), 'Relink File').press('Enter')
  const relink = page.getByRole('dialog', { name: 'Relink file', exact: true })
  await button(relink, 'Relink').click()
  await relink.waitFor({ state: 'hidden' })
  await seek().waitFor()
  assert.equal(Number(await seek().getAttribute('aria-valuemax')), 3)
  await button(item(), 'Play audio').click()
  await button(item(), 'Pause audio').waitFor()
  await button(item(), 'Pause audio').click()
  await button(item(), 'Play audio').waitFor()
  const replaced = await state()
  assert.notEqual(replaced.assetId, saved.assetId)
  assert.equal(replaced.id, saved.id)
  assert.deepEqual(replaced.appearance, saved.appearance)
  assert.equal(replaced.asset, 'Synthetic replacement recording.wav')
  assert.equal(replaced.copied, false)
  assert.equal(await item().locator('audio').count(), 1)
  assert.equal(digest(await readFile(sourcePath)), digest(source))
  assert.equal(digest(await readFile(replacementPath)), digest(replacement))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.keyboard.press('Control+Shift+l')
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await button(page, 'Fit All').click()
  await item().locator('.ic-object-title').click()
  const options = page.getByRole('group', { name: 'Audio', exact: true })
  await options.getByLabel('Audio display').waitFor()
  const narrow = await options.boundingBox()
  assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 391)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.keyboard.press('Escape')
  await seek().press('End')
  assert.equal(await item().locator('audio').evaluate(media => media.currentTime), 3)
  await seek().press('Home')
  assert.equal(await item().locator('audio').evaluate(media => media.currentTime), 0)
  await seek().press('Space')
  await button(item(), 'Pause audio').waitFor()
  await seek().press('Space')
  await button(item(), 'Play audio').waitFor()
  assert.deepEqual(errors, [])
  console.log(`Linked WAV UI passed. A real file drag, rename and restart (${reopened.permission}), injected denial and a genuine replacement handle preserved appearance and both file hashes. Relink regenerated the waveform for a 3s replacement of a 2s original. The dark 390px player and inspector fit, and Home, End and Space controlled the waveform through the keyboard.`)
} finally {
  await browser?.close()
  if (dirname(resolve(workspace)) === testRoot && workspace.startsWith(join(testRoot, 'croft-linked-audio-')))
    await rm(workspace, { recursive: true, force: true })
  if (dirname(resolve(profile)) === temp && profile.startsWith(join(temp, 'croft-linked-audio-profile-')))
    await rm(profile, { recursive: true, force: true })
}
