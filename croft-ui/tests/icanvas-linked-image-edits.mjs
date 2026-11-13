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
const workspace = await mkdtemp(join(testRoot, 'croft-linked-image-'))
const sourcePath = join(workspace, 'Croft source fixture.png')
const movedPath = join(workspace, 'Croft source temporarily moved.png')
const replacementPath = join(workspace, 'Croft replacement fixture.png')
const profile = await mkdtemp(join(temp, 'croft-linked-image-profile-'))
const chromePath = process.env.CROFT_QA_CHROME
const errors = []
let browser
let page

async function launch(url = origin.href) {
  browser = await chromium.launchPersistentContext(profile, {
    ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
    headless: true, chromiumSandbox: true, viewport: { width: 1440, height: 900 },
  })
  page = browser.pages()[0] ?? await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin.origin) errors.push(request.url())
  })
  await page.goto(url)
}

const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const stage = () => page.getByRole('region', { name: 'Canvas', exact: true })
const object = () => page.locator('.ic-item[aria-label="Croft source fixture.png"]')
const picture = () => object().locator('.ic-edited-image-paint canvas')
const editDigest = data => createHash('sha256').update(data).digest('hex')

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
  return page.evaluate(async () => {
    const { getAsset, getProjects } = await import('/src/features/icanvas/storage.ts')
    const project = (await getProjects()).find(project => project.id === location.hash.split('/')[1])
    const object = project.objects.find(candidate => candidate.name === 'Croft source fixture.png')
    const asset = await getAsset(object.assetId)
    const permission = await asset.handle?.queryPermission({ mode: 'read' })
    return { id: object.id, assetId: asset.id, width: object.width, height: object.height,
      imageEdits: object.imageEdits, name: asset.name, native: asset.handle instanceof FileSystemFileHandle,
      linked: asset.linked, copied: !!asset.blob, permission }
  })
}

async function save() {
  await page.keyboard.press('Control+s')
  await button(page, 'Save menu').getByText('Saved', { exact: true }).waitFor()
}

try {
  await launch()
  const fixtures = await page.evaluate(() => [[110, 82], [90, 130]].map(([width, height]) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const painter = canvas.getContext('2d')
    painter.fillStyle = '#e18f35'
    painter.fillRect(0, 0, width / 2, height)
    painter.fillStyle = '#1b7da9'
    painter.fillRect(width / 2, 0, width / 2, height)
    return canvas.toDataURL().split(',')[1]
  }))
  const [sourceDigest, replacementDigest] = fixtures.map(value => editDigest(Buffer.from(value, 'base64')))
  await writeFile(sourcePath, Buffer.from(fixtures[0], 'base64'), { flag: 'wx' })
  await writeFile(replacementPath, Buffer.from(fixtures[1], 'base64'), { flag: 'wx' })
  await openCanvas()
  await dropRealFile(sourcePath)
  const add = page.getByRole('dialog', { name: 'Add files', exact: true })
  await button(add, 'Link In').click()
  await button(add, 'Add').click()
  await add.waitFor({ state: 'hidden' })
  await button(page, 'Fit All').click()
  await object().locator('img').waitFor()
  await object().click()
  const toolbar = stage().getByRole('toolbar', { name: 'Selection actions' })
  await button(toolbar, 'Crop').click()
  const crop = () => page.getByRole('dialog', { name: 'Crop & Straighten', exact: true })
  await crop().getByLabel('Crop aspect ratio').selectOption('1:1')
  await button(crop(), 'Apply Crop').click()
  await picture().waitFor()
  await save()
  const saved = await state()
  assert.deepEqual(saved.imageEdits.source, { width: 110, height: 82 })
  assert.equal(saved.imageEdits.crop.height, 1)
  assert.equal(saved.native, true)
  assert.equal(saved.linked, true)
  assert.equal(saved.copied, false)
  assert.equal(saved.permission, 'granted')
  assert.equal(editDigest(await readFile(sourcePath)), sourceDigest)

  await rename(sourcePath, movedPath)
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByRole('button', { name: 'Home', exact: true }).click()
  await openCanvas()
  await object().getByText('File missing or moved', { exact: true }).waitFor()
  assert.deepEqual(await state(), saved)
  await rename(movedPath, sourcePath)
  await button(object(), 'Check again').click()
  await picture().waitFor()

  const reopenedUrl = page.url()
  await browser.close()
  browser = undefined
  await launch(reopenedUrl)
  await stage().waitFor()
  const reopened = await state()
  assert.deepEqual({ ...reopened, permission: saved.permission }, saved)
  if (reopened.permission !== 'granted') await button(object(), 'Restore access').waitFor()
  else await picture().waitFor()
  await page.evaluate(() => {
    const queryPermission = FileSystemHandle.prototype.queryPermission
    const requestPermission = FileSystemHandle.prototype.requestPermission
    FileSystemHandle.prototype.queryPermission = function (options) {
      return this.name === 'Croft source fixture.png' ? Promise.resolve('denied') : queryPermission.call(this, options)
    }
    FileSystemHandle.prototype.requestPermission = function (options) {
      if (this.name !== 'Croft source fixture.png') return requestPermission.call(this, options)
      if (options.mode !== 'read') throw new Error('Unexpected request for write permission')
      return Promise.resolve('denied')
    }
    window.dispatchEvent(new Event('focus'))
  })
  await object().getByText('File access denied', { exact: true }).waitFor()
  await button(object(), 'Restore access').press('Enter')
  assert.deepEqual(await state(), { ...saved, permission: 'denied' })
  await page.evaluate(() => {
    document.addEventListener('drop', event => {
      event.preventDefault()
      event.stopImmediatePropagation()
      window.croftSyntheticHandle = event.dataTransfer.items[0].getAsFileSystemHandle()
    }, { capture: true, once: true })
  })
  await dropRealFile(replacementPath)
  await page.evaluate(async () => {
    const handle = await window.croftSyntheticHandle
    if (!(handle instanceof FileSystemFileHandle)) throw new Error('Expected a genuine Chrome host-file handle.')
    window.showOpenFilePicker = async ({ multiple }) => {
      if (multiple) throw new Error('Expected one file at relink.')
      return [handle]
    }
  })
  await button(object(), 'Relink File').press('Enter')
  const relink = page.getByRole('dialog', { name: 'Relink file', exact: true })
  await button(relink, 'Relink').click()
  await relink.waitFor({ state: 'hidden' })
  await object().getByText(/source dimensions changed/i).waitFor()
  const replaced = await state()
  assert.equal(replaced.id, saved.id)
  assert.notEqual(replaced.assetId, saved.assetId)
  assert.deepEqual(replaced.imageEdits, saved.imageEdits)
  assert.equal(replaced.linked, true)
  assert.equal(replaced.copied, false)
  await object().click()
  await button(stage().getByRole('toolbar', { name: 'Selection actions' }), 'Crop').click()
  await crop().getByLabel('Crop aspect ratio').selectOption('1:1')
  await button(crop(), 'Apply Crop').click()
  await picture().waitFor()
  await save()
  const recovered = await state()
  assert.deepEqual(recovered.imageEdits.source, { width: 90, height: 130 })
  assert.equal(recovered.width, saved.width)
  assert.equal(recovered.height, saved.height)
  assert.equal(editDigest(await readFile(sourcePath)), sourceDigest)
  assert.equal(editDigest(await readFile(replacementPath)), replacementDigest)
  assert.deepEqual(errors, [])
  console.log(`Edited linked PNG and immutable SHA-256 source bytes verified through actual Chrome host-file handles, rename and restart (${reopened.permission}), injected denial, relink dimension mismatch and Apply Crop recovery.`)
} finally {
  await browser?.close()
  if (dirname(resolve(workspace)) === testRoot && workspace.startsWith(join(testRoot, 'croft-linked-image-')))
    await rm(workspace, { recursive: true, force: true })
  if (dirname(resolve(profile)) === temp && profile.startsWith(join(temp, 'croft-linked-image-profile-')))
    await rm(profile, { recursive: true, force: true })
}
