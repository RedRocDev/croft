import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'

const [playwrightPath, chromePath, origin = 'http://localhost:5173', pdfInfo, screenshotsDirectory] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true })
try {
  if (screenshotsDirectory) await mkdir(screenshotsDirectory, { recursive: true })
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

  const stackId = await page.evaluate(async () => {
    const { createProject, makeObject } = await import('/src/features/icanvas/model.ts')
    const { saveProjects } = await import('/src/features/icanvas/storage.ts')
    const project = createProject('Rotated card stack export')
    const frame = makeObject('frame', { x: 35, y: 38 }, { name: 'Export frame', width: 940, height: 500 })
    const stack = makeObject('stack', { x: 80, y: 100 }, { name: 'Export pile', parentId: frame.id, rotation: 12 })
    const top = makeObject('note', { x: 80, y: 100 }, {
      name: 'Top note', parentId: stack.id, rotation: 19, text: 'Top front content', visibleSide: 'back',
      back: { title: 'Top back content', text: 'Visible on every exported layout' },
    })
    const rear = makeObject('note', { x: 155, y: 155 }, {
      name: 'Rear note', parentId: stack.id, text: 'Rear front content', visibleSide: 'back',
      back: { title: 'Rear back content', text: 'Appears after fanning', assetId: 'browser-export-reverse' },
    })
    const attachment = new Blob(['synthetic browser reverse attachment'], { type: 'text/plain' })
    stack.stack = { order: [top.id, rear.id], layout: 'compact' }
    project.objects = [frame, stack, top, rear]
    await saveProjects([project], [{ id: 'browser-export-reverse', name: 'reverse.txt', mime: attachment.type, size: attachment.size, blob: attachment }])
    return project.id
  })
  await page.goto(`${origin}/#canvas/${stackId}`)
  await page.reload()
  await canvas.getByText('Top back content', { exact: true }).waitFor()
  assert.equal(await canvas.getByText('Rear back content', { exact: true }).count(), 0)
  if (screenshotsDirectory) await canvas.screenshot({ path: path.join(screenshotsDirectory, 'compact-editor.png'), animations: 'disabled' })
  const compactExport = await download('svg')
  const compactSvg = compactExport.bytes.toString('utf8')
  assert.match(compactSvg, /Top back content/)
  assert.match(compactSvg, />Back<\/text>/)
  assert.match(compactSvg, />exported layout<\/tspan>/)
  assert.match(compactSvg, /Export frame/)
  assert.match(compactSvg, /data-stack-rear="true"/)
  assert.match(compactSvg, /rotate\(19 /)
  assert.doesNotMatch(compactSvg, /Rear back content|Top front content|Rear front content/)
  const view = await decodeImage(compactExport.bytes, 'image/svg+xml')
  const compactPng = (await download('png')).bytes
  const pngView = await decodeImage(compactPng, 'image/png')
  const jpgView = await decodeImage((await download('jpg')).bytes, 'image/jpeg')
  assert.deepEqual([pngView.width, pngView.height], [view.width, view.height])
  assert.deepEqual([jpgView.width, jpgView.height], [view.width, view.height])
  if (screenshotsDirectory) await writeFile(path.join(screenshotsDirectory, 'compact-export.png'), compactPng)
  assert.match((await download('pdf')).bytes.subarray(0, 8).toString('ascii'), /^%PDF-1\.4/)
  const stackFiles = unzipSync((await download('croft')).bytes)
  const stackPackage = JSON.parse(Buffer.from(stackFiles['manifest.json']).toString('utf8'))
  assert.equal(stackPackage.version, 2)
  const packagedObjects = stackPackage.projects[0].objects
  assert.deepEqual(packagedObjects.find(object => object.kind === 'stack').stack.order, packagedObjects.filter(object => object.kind === 'note').map(object => object.id))
  const reverse = stackPackage.assets.find(asset => asset.name === 'reverse.txt')
  assert.equal(Buffer.from(stackFiles[reverse.path]).toString('utf8'), 'synthetic browser reverse attachment')
  assert.deepEqual(JSON.parse(Buffer.from(unzipSync((await download('zip')).bytes)['manifest.json']).toString('utf8')), stackPackage)

  await page.evaluate(async id => {
    const { getWorkspaceStorageState, saveProjects } = await import('/src/features/icanvas/storage.ts')
    const project = (await getWorkspaceStorageState()).projects.find(canvas => canvas.id === id)
    const stack = project.objects.find(object => object.kind === 'stack')
    stack.stack.layout = 'fan'
    await saveProjects([{ ...project, updatedAt: Date.now() }])
  }, stackId)
  await page.reload()
  await canvas.getByText('Rear back content', { exact: true }).waitFor()
  if (screenshotsDirectory) await canvas.screenshot({ path: path.join(screenshotsDirectory, 'fan-editor.png'), animations: 'disabled' })
  const fanExport = (await download('svg')).bytes.toString('utf8')
  assert.match(fanExport, /Top back content/)
  assert.match(fanExport, /Rear back content/)
  assert.match(fanExport, /Appears after fanning<\/tspan>/)
  assert.match(fanExport, /reverse\.txt/)
  assert.doesNotMatch(fanExport, /data-stack-rear="true"|Top front content|Rear front content/)
  if (screenshotsDirectory) await writeFile(path.join(screenshotsDirectory, 'fan-export.png'), (await download('png')).bytes)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(network, [])
  console.log('iCanvas browser export QA passed: all six formats, static descendant ZIP, nested editable reimport, and visible compact/fan exports of a rotated card stack with editable Back attachment bytes.')
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page && !page.isClosed()) console.error((await page.locator('body').innerText()).slice(0, 2000))
  throw error
} finally {
  await browser.close()
}
