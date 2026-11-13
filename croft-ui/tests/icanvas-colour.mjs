import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const url = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173')
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  throw new Error('CROFT_QA_URL must be a localhost HTTP origin.')
}

const browser = await chromium.launch({
  ...(process.env.CROFT_QA_CHROME ? { executablePath: process.env.CROFT_QA_CHROME } : { channel: 'chrome' }),
  headless: true,
  chromiumSandbox: true,
})

try {
  const errors = []
  async function openSeed(options) {
    const page = await browser.newPage({ reducedMotion: 'reduce', ...options })
    page.setDefaultTimeout(8_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', response => {
      if (response.status() >= 400) errors.push(response.status() + ' ' + response.url())
    })
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== url.origin) errors.push(request.url())
    })
    await page.goto(url.href, { waitUntil: 'networkidle' })
    await page.getByRole('region', { name: 'Canvas projects' })
      .getByRole('button', { name: /Holiday Ideas A visual itinerary/ }).click()
    await page.getByRole('region', { name: 'Canvas', exact: true }).waitFor()
    return page
  }

  const page = await openSeed({ viewport: { width: 1440, height: 900 } })

  const note = page.locator('.ic-item[data-kind="note"][aria-label="The plan"]')
  await note.click({ position: { x: 45, y: 50 } })
  const inspector = page.getByRole('complementary', { name: 'Canvas inspector' })
  const appearance = inspector.getByRole('group', { name: 'Appearance', exact: true })
  const opener = appearance.getByRole('button', { name: 'Custom colour', exact: true })
  const apply = inspector.getByRole('button', { name: 'Apply colour', exact: true })
  const cancel = inspector.getByRole('button', { name: 'Cancel', exact: true })
  const hex = inspector.getByRole('textbox', { name: 'HEX', exact: true })
  const rgb = ['Red', 'Green', 'Blue'].map(name => inspector.getByRole('spinbutton', { name, exact: true }))
  const readRgb = async () => Promise.all(rgb.map(input => input.inputValue().then(Number)))
  const objectId = (await note.getAttribute('data-testid')).replace('canvas-object-', '')
  const getColour = () => note.evaluate(element => getComputedStyle(element).getPropertyValue('--ic-item-colour').trim().toLowerCase())
  const waitForColour = expected => page.waitForFunction(({ id, expected }) => {
    const item = document.querySelector('[data-testid="canvas-object-' + id + '"]')
    return item && getComputedStyle(item).getPropertyValue('--ic-item-colour').trim().toLowerCase() === expected
  }, { id: objectId, expected })
  const initial = await getColour()
  assert.match(initial, /^#[0-9a-f]{6}$/)

  await opener.click()
  assert.equal(await opener.getAttribute('aria-expanded'), 'true')
  assert.equal((await hex.inputValue()).toLowerCase(), initial)
  const wheel = inspector.getByRole('group', { name: 'Colour wheel', exact: true }).locator('[data-colour-wheel]')
  const bounds = await wheel.boundingBox()
  assert.ok(bounds, 'The colour wheel must be visible.')
  await wheel.click({ position: { x: bounds.width * 0.73, y: bounds.height * 0.68 } })
  assert.notEqual((await hex.inputValue()).toLowerCase(), initial)
  const [wheelRed, wheelGreen, wheelBlue] = await readRgb()
  const rgbHex = (red, green, blue) => '#' + [red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')
  assert.equal((await hex.inputValue()).toLowerCase(), rgbHex(wheelRed, wheelGreen, wheelBlue))
  assert.equal(await getColour(), initial, 'Wheel movement only changes the draft.')

  const wheelHex = await hex.inputValue()
  for (const name of ['Hue', 'Saturation', 'Brightness']) {
    const slider = inspector.getByRole('slider', { name, exact: true })
    await slider.waitFor()
    await slider.focus()
    assert.equal(await slider.evaluate(element => element === document.activeElement), true)
  }
  await inspector.getByRole('slider', { name: 'Brightness', exact: true }).press('Home')
  assert.equal((await hex.inputValue()).toLowerCase(), '#000000')
  assert.notEqual(await hex.inputValue(), wheelHex)

  await hex.fill('#275eb5')
  assert.deepEqual(await readRgb(), [39, 94, 181])
  await rgb[0].fill('64')
  assert.equal((await hex.inputValue()).toLowerCase(), '#405eb5')
  await rgb[1].fill('128')
  await rgb[2].fill('224')
  assert.equal((await hex.inputValue()).toLowerCase(), '#4080e0')
  await rgb[2].fill('999')
  assert.equal(await rgb[2].getAttribute('aria-invalid'), 'true')
  assert.equal(await apply.isDisabled(), true)
  await hex.fill('#nothex')
  assert.equal(await hex.getAttribute('aria-invalid'), 'true')
  assert.equal(await apply.isDisabled(), true)
  assert.equal(await getColour(), initial)
  await hex.fill('#275eb5')
  assert.equal(await apply.isEnabled(), true)
  await apply.click()
  await waitForColour('#275eb5')
  assert.equal(await note.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(39, 94, 181)')
  await hex.waitFor({ state: 'hidden' })

  const preset = '#cfe9d8'
  await appearance.getByRole('button', { name: 'Select colour ' + preset, exact: true }).click()
  await waitForColour(preset)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await waitForColour('#275eb5')
  await note.click({ position: { x: 45, y: 50 } })
  await opener.click()
  await hex.fill('#aa6633')
  await cancel.click()
  await hex.waitFor({ state: 'hidden' })
  assert.equal(await opener.getAttribute('aria-expanded'), 'false')
  assert.equal(await opener.evaluate(element => element === document.activeElement), true)
  assert.equal(await getColour(), '#275eb5')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await waitForColour(initial)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await waitForColour('#275eb5')

  await note.focus()
  await page.keyboard.press('Control+s')
  await page.getByRole('button', { name: 'Save menu', exact: true }).getByText('Saved', { exact: true }).waitFor()
  const stored = await page.evaluate(async id => {
    const request = operation => new Promise((resolve, reject) => {
      operation.onsuccess = () => resolve(operation.result)
      operation.onerror = () => reject(operation.error)
    })
    const db = await request(indexedDB.open('croft-icanvas'))
    try {
      const projectId = location.hash.split('/')[1]
      const project = await request(db.transaction('projects').objectStore('projects').get(projectId))
      return project.objects.find(object => object.id === id)?.colour
    } finally { db.close() }
  }, objectId)
  assert.equal(stored, '#275eb5')
  await page.reload({ waitUntil: 'networkidle' })
  await waitForColour('#275eb5')
  await note.click({ position: { x: 45, y: 50 } })
  await opener.click()
  assert.equal((await hex.inputValue()).toLowerCase(), '#275eb5')
  assert.deepEqual(await readRgb(), [39, 94, 181])
  await cancel.click()

  const quick = page.getByRole('toolbar', { name: 'Selection actions', exact: true })
  const lock = quick.getByRole('button', { name: 'Lock', exact: true, pressed: false })
  const unlock = quick.getByRole('button', { name: 'Unlock', exact: true, pressed: true })
  await lock.locator('svg.lucide-lock-open').waitFor()
  await lock.click()
  await unlock.locator('svg.lucide-lock').waitFor()
  assert.equal(await inspector.getByRole('button', { name: 'Unlock object', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.equal(await opener.isDisabled(), true)
  const left = await note.evaluate(element => element.style.left)
  await note.press('ArrowRight')
  assert.equal(await note.evaluate(element => element.style.left), left)
  await unlock.click()
  await lock.locator('svg.lucide-lock-open').waitFor()
  assert.equal(await opener.isEnabled(), true)
  assert.equal(await getColour(), '#275eb5')

  const canvas = page.getByRole('region', { name: 'Canvas', exact: true })
  const boundsForDrop = await canvas.boundingBox()
  assert.ok(boundsForDrop)
  const fixture = 'Colour border fixture.png'
  const transfer = await page.evaluateHandle(async name => {
    const source = document.createElement('canvas')
    source.width = 32
    source.height = 32
    const drawing = source.getContext('2d')
    drawing.fillStyle = '#f6d55c'
    drawing.fillRect(0, 0, 32, 32)
    const bytes = await new Promise(resolve => source.toBlob(resolve, 'image/png'))
    const data = new DataTransfer()
    data.items.add(new File([bytes], name, { type: 'image/png' }))
    return data
  }, fixture)
  try {
    await canvas.dispatchEvent('drop', {
      dataTransfer: transfer,
      clientX: boundsForDrop.x + 220,
      clientY: boundsForDrop.y + 260,
    })
    const dialog = page.getByRole('dialog', { name: 'Add files', exact: true })
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  } finally { await transfer.dispose() }
  const image = page.locator('.ic-item[data-kind="image"][aria-label="' + fixture + '"]')
  await image.getByRole('img', { name: fixture, exact: true }).waitFor()
  await inspector.getByRole('combobox', { name: /^Display/ }).selectOption({ label: 'Direct' })
  await inspector.getByRole('checkbox', { name: 'Show border', exact: true }).check()
  await opener.click()
  await hex.fill('#275eb5')
  await apply.click()
  assert.equal(await image.getAttribute('data-mode'), 'direct')
  assert.equal(await image.getAttribute('data-border'), 'true')
  const style = await image.evaluate(element => {
    const computed = getComputedStyle(element)
    return { colour: computed.getPropertyValue('--ic-item-colour').trim(), borderColour: computed.borderTopColor, borderWidth: computed.borderTopWidth }
  })
  assert.deepEqual(style, { colour: '#275eb5', borderColour: 'rgb(39, 94, 181)', borderWidth: '2px' })

  const mobile = await openSeed({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await mobile.getByRole('button', { name: 'Project menu', exact: true }).tap()
  await mobile.getByRole('button', { name: 'Find in canvas', exact: true }).tap()
  const find = mobile.getByRole('dialog', { name: 'Find in canvas', exact: true })
  await find.getByRole('textbox', { name: 'Search', exact: true }).fill('The plan')
  await find.getByRole('button', { name: /The plan/ }).tap()
  const mobileInspector = mobile.getByRole('complementary', { name: 'Canvas inspector' })
  await mobileInspector.getByRole('button', { name: 'Custom colour', exact: true }).tap()
  const mobileWheel = mobileInspector.getByRole('group', { name: 'Colour wheel' }).locator('[data-colour-wheel]')
  await mobileWheel.tap({ position: { x: 22, y: 33 } })
  const wheelRect = await mobileWheel.boundingBox()
  assert.ok(wheelRect && wheelRect.x >= 0 && wheelRect.x + wheelRect.width <= 390)
  await mobileInspector.getByRole('textbox', { name: 'HEX', exact: true }).fill('#bb7846')
  await mobileInspector.getByRole('button', { name: 'Apply colour', exact: true }).tap()
  assert.equal(await mobile.locator('.ic-item[data-kind="note"][aria-label="The plan"]').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(187, 120, 70)')
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth), 390)

  assert.deepEqual(errors, [])
  console.log('Custom wheel, keyboard ranges, HEX and RGB agree. Apply, invalid input, presets, Cancel, undo/redo, IndexedDB, reload, selection Lock, Direct image border and 390px touch passed.')
} finally {
  await browser.close()
}
