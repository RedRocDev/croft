import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const url = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173')
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  throw new Error('CROFT_QA_URL must be a localhost HTTP origin.')
}
const tempRoot = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url)).replace(/[\\/]$/, '')
await mkdir(tempRoot, { recursive: true })
const workspace = await mkdtemp(join(tempRoot, 'croft-link-'))
const sourcePath = join(workspace, 'Croft linked fixture.txt')
const movedPath = join(workspace, 'Croft renamed fixture.txt')
const replacementPath = join(workspace, 'Croft replacement fixture.txt')
const profile = await mkdtemp(join(tmpdir(), 'croft-link-profile-'))
const fixture = 'Croft synthetic linked file.\n'
const replacementFixture = 'Croft synthetic replacement file.\n'
const chromePath = process.env.CROFT_QA_CHROME
let browser
let page
const errors = []
const launch = async () => {
  browser = await chromium.launchPersistentContext(profile, {
    ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
    headless: true,
    chromiumSandbox: true,
    viewport: { width: 1440, height: 900 },
  })
  page = browser.pages()[0] ?? await browser.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== url.origin) errors.push(request.url())
  })
}

const box = () => page.getByRole('region', { name: 'Canvas', exact: true })
const item = () => page.locator('.ic-item[aria-label="Croft linked fixture.txt"]')
const button = (scope, name) => scope.getByRole('button', { name, exact: true })
const state = async () => page.evaluate(async () => {
  const read = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const db = await read(indexedDB.open('croft-icanvas'))
  try {
    const projectId = location.hash.split('/')[1]
    const transaction = db.transaction(['projects', 'assets'])
    const project = await read(transaction.objectStore('projects').get(projectId))
    const object = project.objects.find(candidate => candidate.name === 'Croft linked fixture.txt')
    const asset = await read(transaction.objectStore('assets').get(object.assetId))
    const permission = await asset.handle?.queryPermission({ mode: 'read' })
    return {
      objectId: object.id,
      assetId: asset.id,
      name: asset.name,
      isNativeHandle: asset.handle instanceof FileSystemFileHandle,
      permission,
      linked: asset.linked,
      byteCopy: Boolean(asset.blob),
    }
  } finally { db.close() }
})

async function dropRealFile(path) {
  const area = await box().boundingBox()
  assert.ok(area)
  const client = await browser.newCDPSession(page)
  try {
    const data = { items: [], files: [path], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await client.send('Input.dispatchDragEvent', { type, x: area.x + 260, y: area.y + 320, data })
    }
  } finally { await client.detach() }
}

try {
  await writeFile(sourcePath, fixture, { flag: 'wx' })
  await writeFile(replacementPath, replacementFixture, { flag: 'wx' })
  await launch()
  await page.goto(url.href)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).click()
  await box().waitFor()
  await dropRealFile(sourcePath)
  const add = page.getByRole('dialog', { name: 'Add files', exact: true })
  await button(add, 'Link In').press('Enter')
  await button(add, 'Add').press('Enter')
  await add.waitFor({ state: 'hidden' })
  const tile = item()
  await button(page, 'Fit All').press('Enter')
  await tile.waitFor()
  const record = await state()
  assert.equal(record.isNativeHandle, true)
  assert.equal(record.permission, 'granted')
  assert.equal(record.linked, true)
  assert.equal(record.byteCopy, false)
  const downloadLink = tile.getByRole('link', { name: 'Download' })
  await downloadLink.waitFor()
  assert.equal(await readFile(sourcePath, 'utf8'), fixture)
  const nextDownload = page.waitForEvent('download')
  await downloadLink.press('Enter')
  const download = await nextDownload
  await download.saveAs(join(workspace, 'downloaded.txt'))
  assert.equal(await readFile(join(workspace, 'downloaded.txt'), 'utf8'), fixture)
  console.log('Real Chrome drag handle grants read access and persists metadata without a byte copy.')

  await rename(sourcePath, movedPath)
  // Remount the canvas in the existing page. Reload can change browser permission independently.
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByRole('button', { name: 'Home', exact: true }).click()
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).click()
  await tile.getByText('File missing or moved', { exact: true }).waitFor()
  await button(tile, 'Relink File').waitFor()
  assert.deepEqual(await state(), record)
  await rename(movedPath, sourcePath)
  await button(tile, 'Check again').click()
  await tile.getByRole('link', { name: 'Download' }).waitFor()
  console.log('A genuinely renamed source leaves the persisted link intact; Check again recovers the restored path.')

  const canvasUrl = page.url()
  await browser.close()
  browser = undefined
  await launch()
  await page.goto(canvasUrl)
  await box().waitFor()
  const reopened = await state()
  const reopenedTile = item()
  assert.deepEqual({ ...reopened, permission: record.permission }, record)
  if (reopened.permission === 'granted') {
    await reopenedTile.getByRole('link', { name: 'Download' }).waitFor()
  } else {
    const label = reopened.permission === 'denied' ? 'File access denied' : 'File permission needed'
    await reopenedTile.getByText(label, { exact: true }).waitFor()
    await button(reopenedTile, 'Restore access').waitFor()
    await button(reopenedTile, 'Relink File').waitFor()
  }
  assert.equal(await readFile(sourcePath, 'utf8'), fixture)
  assert.deepEqual(errors, [])
  console.log(`Full Chrome restart preserved the same native handle. Browser permission after restart: ${reopened.permission}.`)

  // Simulate only the picker return, using a genuine new host handle from Chrome's drag API.
  // Explicitly override permission methods on that prototype in this isolated test page to cover denied/regrant.
  await page.evaluate(() => {
    const originalQuery = FileSystemHandle.prototype.queryPermission
    const originalRequest = FileSystemHandle.prototype.requestPermission
    window.croftPermissionOverride = 'denied'
    FileSystemHandle.prototype.queryPermission = function (options) {
      return this.name === 'Croft linked fixture.txt' && window.croftPermissionOverride
        ? Promise.resolve(window.croftPermissionOverride) : originalQuery.call(this, options)
    }
    FileSystemHandle.prototype.requestPermission = function (options) {
      if (this.name !== 'Croft linked fixture.txt' || !window.croftPermissionOverride) return originalRequest.call(this, options)
      if (options.mode !== 'read') throw new Error('Croft may only request read permission.')
      return Promise.resolve('denied')
    }
    window.dispatchEvent(new Event('focus'))
  })
  await reopenedTile.getByText('File access denied', { exact: true }).waitFor()
  await button(reopenedTile, 'Restore access').press('Enter')
  await reopenedTile.getByText('File access denied', { exact: true }).waitFor()
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
    if (!(handle instanceof FileSystemFileHandle)) throw new Error('Replacement needs a real native file handle.')
    window.showOpenFilePicker = async ({ multiple }) => {
      if (multiple) throw new Error('Relink must ask for one replacement file.')
      return [handle]
    }
  })
  await button(reopenedTile, 'Relink File').press('Enter')
  const relink = page.getByRole('dialog', { name: 'Relink file', exact: true })
  assert.equal(await button(relink, 'Link In').getAttribute('aria-pressed'), 'true')
  await button(relink, 'Relink').press('Enter')
  await relink.waitFor({ state: 'hidden' })
  await reopenedTile.getByRole('link', { name: 'Download' }).waitFor()
  const replacement = await state()
  assert.equal(replacement.objectId, record.objectId)
  assert.notEqual(replacement.assetId, record.assetId)
  assert.equal(replacement.name, 'Croft replacement fixture.txt')
  assert.equal(replacement.isNativeHandle, true)
  assert.equal(replacement.byteCopy, false)
  assert.equal(await readFile(sourcePath, 'utf8'), fixture)
  assert.equal(await readFile(replacementPath, 'utf8'), replacementFixture)
  console.log('Controlled denial stays distinct; Relink stores a new real read-only handle on the same object without modifying either host file.')
} finally {
  await browser?.close()
  if (dirname(resolve(workspace)) === tempRoot) await rm(workspace, { recursive: true, force: true })
  if (dirname(resolve(profile)) === resolve(tmpdir())) await rm(profile, { recursive: true, force: true })
}
