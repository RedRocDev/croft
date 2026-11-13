import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'

const [playwrightPath, chromePath, origin = 'http://localhost:5173', pdfInfo] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, acceptDownloads: true })
  console.log('Chrome', browser.version())
  const pageErrors = []
  const network = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(origin).origin) network.push(request.url())
  })
  await page.goto(origin)
  const rootButton = page.getByRole('region', { name: 'Canvas projects' }).getByRole('button', { name: /Holiday Ideas/ }).filter({ has: page.locator('strong') })
  await rootButton.first().click()
  const canvas = page.getByRole('region', { name: 'Canvas', exact: true })
  await canvas.waitFor()

  const fixtureText = 'Synthetic attachment for iCanvas export.'
  const files = await page.evaluateHandle(text => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([text], 'itinerary.txt', { type: 'text/plain' }))
    return transfer
  }, fixtureText)
  await canvas.dispatchEvent('drop', { dataTransfer: files })
  const importer = page.getByRole('dialog', { name: 'Add files' })
  await importer.getByRole('button', { name: 'Add', exact: true }).click()
  await importer.waitFor({ state: 'hidden' })
  await canvas.getByLabel('itinerary.txt', { exact: true }).getByRole('link', { name: 'Download' }).waitFor()

  async function download(format, scope = 'canvas', background) {
    await page.getByRole('button', { name: 'Project menu' }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export canvas' })
    await dialog.getByLabel('Format').selectOption(format)
    await dialog.getByLabel('Scope').selectOption(scope)
    if (background) await dialog.getByLabel('Background').selectOption(background)
    const [file] = await Promise.all([
      page.waitForEvent('download', { timeout: 25_000 }),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ])
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await file.failure(), null)
    const localPath = await file.path()
    const bytes = await readFile(localPath)
    console.log(file.suggestedFilename(), bytes.length, 'bytes')
    return { file, localPath, bytes }
  }

  async function decodeImage(bytes, type) {
    return page.evaluate(async ({ encoded, type }) => {
      const image = new Image()
      image.src = `data:${type};base64,${encoded}`
      await image.decode()
      const surface = document.createElement('canvas')
      surface.width = image.naturalWidth
      surface.height = image.naturalHeight
      const context = surface.getContext('2d')
      context.drawImage(image, 0, 0)
      return { width: image.naturalWidth, height: image.naturalHeight, corner: Array.from(context.getImageData(0, 0, 1, 1).data) }
    }, { encoded: bytes.toString('base64'), type })
  }

  const svg = await download('svg', 'canvas', 'grid')
  const svgText = svg.bytes.toString('utf8')
  assert.match(svgText, /<svg\b/)
  assert.match(svgText, /Weekend in Paris/)
  assert.match(svgText, /fill="url\(#grid\)"/)
  const svgImage = await decodeImage(svg.bytes, 'image/svg+xml')
  assert.ok(svgImage.width > 100 && svgImage.height > 100)

  const png = await download('png', 'canvas', 'transparent')
  assert.equal(png.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  const pngImage = await decodeImage(png.bytes, 'image/png')
  assert.equal(pngImage.width, svgImage.width)
  assert.equal(pngImage.height, svgImage.height)
  assert.equal(pngImage.corner[3], 0)

  const jpg = await download('jpg', 'canvas', 'clean')
  assert.equal(jpg.bytes.subarray(0, 3).toString('hex'), 'ffd8ff')
  const jpgImage = await decodeImage(jpg.bytes, 'image/jpeg')
  assert.equal(jpgImage.width, svgImage.width)
  assert.equal(jpgImage.height, svgImage.height)
  assert.equal(jpgImage.corner[3], 255)

  const pdf = await download('pdf', 'canvas', 'clean')
  assert.match(pdf.bytes.subarray(0, 8).toString('ascii'), /^%PDF-1\.4/)
  assert.match(pdf.bytes.subarray(-96).toString('ascii'), /startxref\s+\d+\s+%%EOF/)
  if (pdfInfo) {
    const { stdout } = await promisify(execFile)(pdfInfo, [pdf.localPath])
    assert.match(stdout, /^Pages:\s+1$/m)
    assert.match(stdout, /^Page size:\s+\d+ x \d+ pts \(A4\)$/m)
    console.log('Poppler confirmed 1 A4 page in PDF')
  }

  const native = await download('croft', 'project')
  const editableZip = await download('zip', 'project')
  const filesByName = unzipSync(native.bytes)
  const manifest = JSON.parse(Buffer.from(filesByName['manifest.json']).toString('utf8'))
  const zipManifest = JSON.parse(Buffer.from(unzipSync(editableZip.bytes)['manifest.json']).toString('utf8'))
  assert.deepEqual(zipManifest, manifest)
  assert.equal(manifest.version, 1)
  const [originalRoot, originalChild, originalGrandchild] = ['Holiday Ideas', 'Hotels', 'Paris Hotels'].map(name => manifest.projects.find(project => project.name === name))
  assert.equal(originalChild.parentId, originalRoot.id)
  assert.equal(originalGrandchild.parentId, originalChild.id)
  const attached = manifest.assets.find(asset => asset.name === 'itinerary.txt')
  assert.equal(Buffer.from(filesByName[attached.path]).toString('utf8'), fixtureText)

  const descendants = await download('svg', 'project', 'clean')
  assert.equal(descendants.file.suggestedFilename().endsWith('-svg.zip'), true)
  const filesInDescendants = unzipSync(descendants.bytes)
  assert.equal(Object.keys(filesInDescendants).length, 3)
  assert.ok(Object.keys(filesInDescendants).every(name => name.endsWith('.svg')))

  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByRole('button', { name: 'Home' }).click()
  await page.locator('input[type="file"][accept=".croft,.zip"]').setInputFiles({ name: 'holiday-reimport.croft', mimeType: 'application/zip', buffer: native.bytes })
  await page.getByRole('status').filter({ hasText: 'Project imported.' }).waitFor()
  const copies = page.getByRole('region', { name: 'Canvas projects' }).getByRole('button', { name: /Holiday Ideas/ }).filter({ has: page.locator('strong') })
  assert.equal(await copies.count(), 2)
  await copies.last().click()
  await canvas.getByLabel('itinerary.txt', { exact: true }).getByRole('link', { name: 'Download' }).waitFor()
  const reexport = await download('croft', 'project')
  const reimportedFiles = unzipSync(reexport.bytes)
  const reimported = JSON.parse(Buffer.from(reimportedFiles['manifest.json']).toString('utf8'))
  const importedRoot = reimported.projects.find(project => project.name === 'Holiday Ideas')
  const importedChild = reimported.projects.find(project => project.name === 'Hotels')
  assert.notEqual(importedRoot.id, originalRoot.id)
  assert.equal(importedChild.parentId, importedRoot.id)
  assert.equal(importedRoot.objects.find(object => object.kind === 'canvas').targetId, importedChild.id)
  const copiedAsset = reimported.assets.find(asset => asset.name === 'itinerary.txt')
  assert.notEqual(copiedAsset.id, attached.id)
  assert.equal(Buffer.from(reimportedFiles[copiedAsset.path]).toString('utf8'), fixtureText)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(network, [])
  console.log('iCanvas browser export QA passed: all six formats, static descendant ZIP, nested editable reimport, and attachment round-trip.')
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page && !page.isClosed()) console.error((await page.locator('body').innerText()).slice(0, 2000))
  throw error
} finally {
  await browser.close()
}
