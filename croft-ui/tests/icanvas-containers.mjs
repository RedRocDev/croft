import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
const browser = await chromium.launch({ channel: process.env.CROFT_QA_CHROME ? undefined : 'chrome',
  executablePath: process.env.CROFT_QA_CHROME, chromiumSandbox: true })

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  const button = (name, root = page) => root.getByRole('button', { name, exact: true })
  await button('New Project').click()
  const dialog = page.getByRole('dialog', { name: 'New canvas project' })
  await dialog.getByLabel('Name', { exact: true }).fill('Container verification')
  await dialog.getByLabel('Description').fill('Synthetic project icon and container review')
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 16
    const context = canvas.getContext('2d')
    context.fillStyle = '#246546'
    context.fillRect(2, 2, 12, 12)
    return canvas.toDataURL().split(',')[1]
  })
  await dialog.getByLabel('Upload icon').setInputFiles({ name: 'synthetic-icon.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') })
  await button('Create canvas', dialog).click()
  const crumb = page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).locator('[aria-current="page"]')
  await crumb.locator('img').waitFor()
  const url = page.url()
  const id = url.split('/').at(-1)

  const persisted = () => page.evaluate(async projectId => {
    const read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const db = await read(indexedDB.open('croft-icanvas'))
    try {
      const project = await read(db.transaction('projects').objectStore('projects').get(projectId))
      const asset = await read(db.transaction('assets').objectStore('assets').get(project.iconAssetId))
      const bytes = [...new Uint8Array(await asset.blob.arrayBuffer())]
      return { project, bytes }
    } finally { db.close() }
  }, id)

  const initial = await persisted()
  assert.equal(initial.project.description, 'Synthetic project icon and container review')
  assert.deepEqual(Buffer.from(initial.bytes), Buffer.from(image, 'base64'))

  await page.evaluate(async projectId => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('croft-icanvas')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite')
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error)
        const store = tx.objectStore('projects')
        const read = store.get(projectId)
        read.onsuccess = () => {
          const row = read.result
          const object = (id, name, kind, x, y, width, height, parentId) => ({ id, name, kind, x, y, width, height, parentId,
            rotation: 0, opacity: 1, hidden: false, locked: false, text: '', colour: '#dbe7fa', mode: 'direct' })
          row.objects = [object('frame-outer', 'Outer frame', 'frame', 70, 120, 520, 350),
            object('frame-inner', 'Inner frame', 'frame', 150, 190, 260, 190, 'frame-outer'),
            object('group-nested', 'Nested group', 'group', 190, 236, 160, 72, 'frame-inner'),
            object('shape-first', 'First shape', 'rectangle', 200, 245, 58, 50, 'group-nested'),
            object('shape-second', 'Second shape', 'ellipse', 282, 248, 52, 44, 'group-nested')]
          row.edges = [{ id: 'fixture-edge', kind: 'relationship', from: 'shape-first', to: 'shape-second', label: 'Sibling' }]
          row.camera = { x: 14, y: 17, zoom: 1 }
          store.put(row)
        }
      })
    } finally { db.close() }
  }, id)

  await page.reload()
  await crumb.locator('img').waitFor()
  const canvas = page.getByRole('region', { name: 'Canvas', exact: true })
  const outer = canvas.locator('.ic-item[aria-label="Outer frame"]')
  const pane = page.getByRole('complementary', { name: 'Canvas inspector' })
  const saved = page.getByRole('button', { name: 'Save menu', exact: true }).getByText('Saved', { exact: true })
  const commit = async () => { await page.keyboard.press('Control+s'); await saved.waitFor() }
  const metrics = name => pane.getByLabel(name, { exact: true })
  await outer.click({ position: { x: 14, y: 15 } })
  await metrics('Rotation (°)').fill('90')
  await metrics('Rotation (°)').press('Enter')
  await metrics('Width').fill('780')
  await metrics('Width').press('Enter')
  await commit()
  const rotated = await persisted()
  const [root, inner, group, first, second] = rotated.project.objects
  assert.equal(root.rotation, 90)
  assert.equal(root.height, 525)
  const closeTo = (actual, desired) => assert.ok(Math.abs(actual - desired) < 1e-7, `${actual} != ${desired}`)
  const originals = [{ x: 150, y: 190, w: 260, h: 190 }, { x: 190, y: 236, w: 160, h: 72 },
    { x: 200, y: 245, w: 58, h: 50 }, { x: 282, y: 248, w: 52, h: 44 }]
  for (const [index, item] of [inner, group, first, second].entries()) {
    const original = originals[index]
    closeTo(item.width, original.w * 1.5)
    closeTo(item.x + item.width / 2, 460 - (original.y + original.h / 2 - 295) * 1.5)
    closeTo(item.y + item.height / 2, 382.5 + (original.x + original.w / 2 - 330) * 1.5)
    assert.equal(item.rotation, 90)
  }
  assert.equal(rotated.project.edges[0].to, 'shape-second')
  assert.deepEqual(Buffer.from(rotated.bytes), Buffer.from(image, 'base64'))

  await button('Undo').click()
  await button('Undo').click()
  await commit()
  const reverted = await persisted()
  assert.deepEqual(reverted.project.objects.slice(1).map(({ x, y, width: w, height: h }) => ({ x, y, w, h })), originals)
  await page.reload()
  await crumb.locator('img').waitFor()
  await button('Home', page.getByRole('navigation', { name: 'Canvas breadcrumbs' })).click()
  await page.getByRole('region', { name: 'Canvas projects' }).getByRole('button', { name: /Container verification Synthetic/ }).locator('img').waitFor()
  assert.deepEqual(errors, [])
  console.log('Chrome passed custom raster icon creation, exact IndexedDB bytes and reload, nested frame/group transforms, edge identity and atomic undo.')
} finally { await browser.close() }
