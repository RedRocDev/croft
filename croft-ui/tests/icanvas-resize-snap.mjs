import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const url = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173')
assert.ok(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
  'CROFT_QA_URL must be a localhost HTTP origin.')
const browser = await chromium.launch({
  ...(process.env.CROFT_QA_CHROME ? { executablePath: process.env.CROFT_QA_CHROME } : { channel: 'chrome' }),
  headless: true,
  chromiumSandbox: true,
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(8_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== url.origin) errors.push(request.url())
  })

  const button = (name, root = page) => root.getByRole('button', { name, exact: true })
  await page.goto(url.href, { waitUntil: 'networkidle' })
  await button('New Project').click()
  const create = page.getByRole('dialog', { name: 'New canvas project' })
  await create.getByLabel('Name', { exact: true }).fill('Resize snap fixture')
  await button('Create canvas', create).click()
  const canvas = page.getByRole('region', { name: 'Canvas', exact: true })
  await canvas.waitFor()

  // Place a card above and one beside the text card without relying on automatic placement.
  await page.evaluate(async () => {
    const projectId = location.hash.split('/')[1]
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('croft-icanvas')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('projects', 'readwrite')
        transaction.oncomplete = resolve
        transaction.onabort = () => reject(transaction.error)
        const store = transaction.objectStore('projects')
        const request = store.get(projectId)
        request.onsuccess = () => {
          const project = request.result
          const card = (id, name, x, y, width, height) => ({
            id, name, kind: 'text', x, y, width, height, text: name, colour: '#cfe9d8',
            rotation: 0, opacity: 1, hidden: false, locked: false, mode: 'card',
          })
          project.objects = [
            card('resize-top', 'Card above', 122, 92, 240, 140),
            card('resize-side', 'Card to the right', 425, 322, 220, 138),
            card('resize-source', 'Text card', 180, 310, 123, 88),
          ]
          project.camera = { x: 14, y: 17, zoom: 1 }
          project.settings = { ...project.settings, snapGrid: false, snapObjects: true, guides: true }
          store.put(project)
        }
      })
    } finally {
      db.close()
    }
  })
  await page.reload({ waitUntil: 'networkidle' })

  const source = canvas.getByTestId('canvas-object-resize-source')
  const above = canvas.getByTestId('canvas-object-resize-top')
  const side = canvas.getByTestId('canvas-object-resize-side')
  const guideX = canvas.locator('.ic-guide-x')
  const guideY = canvas.locator('.ic-guide-y')
  const bounds = item => item.evaluate(element => {
    const { left, top, width, height } = element.style
    const x = parseFloat(left)
    const y = parseFloat(top)
    return { x, y, right: x + parseFloat(width), bottom: y + parseFloat(height) }
  })
  const original = await bounds(source)
  const aboveRight = (await bounds(above)).right
  const besideBottom = (await bounds(side)).bottom
  assert.deepEqual(original, { x: 180, y: 310, right: 303, bottom: 398 })
  const undo = button('Undo')
  const redo = button('Redo')

  async function resize(dx, dy, { modifier, during } = {}) {
    await source.click({ position: { x: 37, y: 37 } })
    const handle = await button('Resize Text card', source).boundingBox()
    assert.ok(handle, 'The resize handle must be visible.')
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await page.mouse.move(x, y)
    if (modifier) await page.keyboard.down(modifier)
    await page.mouse.down()
    try {
      await page.mouse.move(x + dx, y + dy, { steps: 7 })
      if (during) await during()
    } finally {
      await page.mouse.up()
      if (modifier) await page.keyboard.up(modifier)
    }
    await guideX.waitFor({ state: 'hidden' })
    await guideY.waitFor({ state: 'hidden' })
    return bounds(source)
  }

  async function checkGuide(guide, target, axis) {
    await guide.waitFor({ state: 'visible' })
    const [line, object] = await Promise.all([guide.boundingBox(), target.boundingBox()])
    assert.ok(line && object)
    const expected = axis === 'x' ? object.x + object.width : object.y + object.height
    assert.ok(Math.abs(line[axis] - expected) <= 1, `Guide ${axis} must mark the matched card edge.`)
  }

  const nearRight = aboveRight - original.right - 4
  const alignedRight = { ...original, right: aboveRight, bottom: original.bottom + 19 }
  assert.deepEqual(await resize(nearRight, 19, { during: () => checkGuide(guideX, above, 'x') }), alignedRight)
  assert.equal((await bounds(above)).right, aboveRight)
  await undo.click()
  assert.deepEqual(await bounds(source), original)
  await redo.click()
  assert.deepEqual(await bounds(source), alignedRight)
  await source.focus()
  await page.keyboard.press('Control+s')
  await button('Save menu').getByText('Saved', { exact: true }).waitFor()
  await page.reload({ waitUntil: 'networkidle' })
  assert.deepEqual(await bounds(source), alignedRight)

  const nearBottom = besideBottom - alignedRight.bottom - 4
  const alignedBottom = { ...alignedRight, right: alignedRight.right + 14, bottom: besideBottom }
  assert.deepEqual(await resize(14, nearBottom, { during: () => checkGuide(guideY, side, 'y') }), alignedBottom)
  await undo.click()
  assert.deepEqual(await bounds(source), alignedRight)

  const pastRight = { ...alignedRight, right: aboveRight + 4, bottom: alignedRight.bottom + 10 }
  assert.deepEqual(await resize(4, 10, { modifier: 'Alt' }), pastRight)
  await undo.click()
  assert.deepEqual(await bounds(source), alignedRight)

  const width = alignedRight.right - alignedRight.x
  const height = alignedRight.bottom - alignedRight.y
  const proportionalDy = besideBottom - alignedRight.bottom - 2
  const proportional = await resize(width * proportionalDy / height, proportionalDy, {
    modifier: 'Shift', during: () => checkGuide(guideY, side, 'y'),
  })
  assert.equal(proportional.x, alignedRight.x)
  assert.equal(proportional.y, alignedRight.y)
  assert.equal(proportional.bottom, besideBottom)
  const resizedRatio = (proportional.right - proportional.x) / (proportional.bottom - proportional.y)
  assert.ok(Math.abs(resizedRatio - width / height) < 1e-4, 'Shift resize must preserve the aspect ratio when snapping.')
  await undo.click()
  assert.deepEqual(await bounds(source), alignedRight)

  const toolbarOptions = button('Toolbar options')
  await toolbarOptions.click()
  await page.getByRole('checkbox', { name: 'Snap to Objects', exact: true }).uncheck()
  await toolbarOptions.click()
  assert.deepEqual(await resize(4, 10), pastRight)
  assert.deepEqual(errors, [])
  console.log('Resize snapped exactly to the adjacent right and bottom edges, with guides and a fixed top-left. Shift proportion, Alt bypass, Snap to Objects off, undo/redo and reload passed.')
} finally {
  await browser.close()
}
