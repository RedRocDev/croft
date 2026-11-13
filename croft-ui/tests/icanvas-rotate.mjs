import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const [playwrightPath, chromePath, originArgument] = process.argv.slice(2)
const origin = new URL(originArgument || process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a local Croft origin.')
const { chromium } = require(playwrightPath || process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const executablePath = chromePath || process.env.CROFT_QA_CHROME
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  headless: true,
  chromiumSandbox: true,
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push('External request: ' + request.url())
  })
  const button = name => page.getByRole('button', { name, exact: true })
  await page.goto(origin)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).waitFor()
  const fixture = await page.evaluate(async () => {
    const { createProject, makeObject } = await import('/src/features/icanvas/model.ts')
    const { saveProjects } = await import('/src/features/icanvas/storage.ts')
    const canvas = createProject('Rotation fixture')
    canvas.camera = { x: 80, y: 45, zoom: 1 }
    canvas.settings.minimap = false
    const object = makeObject('rectangle', { x: 440, y: 330 }, { name: 'Rotation target', width: 260, height: 170, rotation: 30 })
    canvas.objects = [object]
    await saveProjects([canvas])
    return { canvasId: canvas.id, objectId: object.id }
  })
  await page.goto(origin + '/?rotation-test=1#canvas/' + fixture.canvasId)
  const object = page.getByTestId('canvas-object-' + fixture.objectId)
  await object.waitFor()
  assert.equal(await button('Rotate 15 degrees').count(), 0)
  const originalBounds = await object.boundingBox()
  assert.ok(originalBounds)
  const center = { x: originalBounds.x + originalBounds.width / 2, y: originalBounds.y + originalBounds.height / 2 }

  async function waitAngle(expected, tolerance = .15) {
    await page.waitForFunction(({ id, value, tolerance }) => {
      const element = document.querySelector('[data-testid="canvas-object-' + id + '"]')
      if (!(element instanceof HTMLElement)) return false
      const angle = Number(element.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1])
      const delta = (angle - value + 540) % 360 - 180
      return Math.abs(delta) <= tolerance
    }, { id: fixture.objectId, value: expected, tolerance }).catch(async error => {
      const actual = await object.evaluate(element => element.style.transform)
      throw new Error(`Expected rotation ${expected}° ± ${tolerance}°, observed ${actual}.`, { cause: error })
    })
  }

  async function begin(angle, edge = 'right') {
    if (await object.getAttribute('data-selected') !== 'true') await page.mouse.click(center.x, center.y)
    const toggle = button('Rotate')
    await toggle.waitFor()
    const handle = page.locator('[data-rotate-edge="' + edge + '"]')
    if (!await handle.isVisible()) await toggle.click()
    const bounds = await handle.boundingBox()
    assert.ok(bounds, 'Rotation mode should expose the ' + edge + ' target.')
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await waitAngle(angle)
    return point
  }

  async function pivot(point, degrees) {
    const radians = degrees * Math.PI / 180
    const x = point.x - center.x
    const y = point.y - center.y
    await page.mouse.move(
      center.x + x * Math.cos(radians) - y * Math.sin(radians),
      center.y + x * Math.sin(radians) + y * Math.cos(radians),
      { steps: 8 },
    )
  }

  await waitAngle(30)
  const first = await begin(30)
  // Clockwise motion increases the angle around the object's visible center.
  await pivot(first, 43)
  await waitAngle(75)
  await page.mouse.up()
  await waitAngle(75)
  assert.equal(await button('Undo').isEnabled(), true)
  await button('Undo').click()
  await waitAngle(30)
  assert.equal(await button('Undo').isDisabled(), true, 'A drag should commit exactly one undo entry.')
  await button('Redo').click()
  await waitAngle(75)

  const freeStart = await begin(75)
  await page.keyboard.down('Alt')
  await pivot(freeStart, 22)
  await waitAngle(97, .8)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await waitAngle(97, .8)
  await button('Undo').click()
  await waitAngle(75)
  await button('Redo').click()
  await waitAngle(97, .8)

  const beforeCancel = await object.evaluate(node => Number(node.style.transform.match(/rotate\(([-\d.]+)deg\)/)?.[1]))
  const cancelStart = await begin(beforeCancel)
  await pivot(cancelStart, 51)
  await waitAngle(150)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await waitAngle(beforeCancel, .1)
  await button('Undo').click()
  await waitAngle(75)
  await button('Redo').click()
  await waitAngle(beforeCancel, .1)

  const toggle = button('Rotate')
  if (!await page.locator('[data-rotate-edge="right"]').isVisible()) await toggle.click()
  const increments = page.getByLabel('Rotation snap increment', { exact: true })
  await increments.selectOption({ label: '30°' })
  const widerSnap = await begin(beforeCancel, 'top')
  await pivot(widerSnap, 34)
  await waitAngle(120)
  await page.mouse.up()
  await waitAngle(120)
  await button('Undo').click()
  await waitAngle(beforeCancel, .1)

  await increments.selectOption({ label: 'Off' })
  const branchPoint = await begin(beforeCancel)
  for (const amount of [30, 60, 90, 120, 150, 180, 210]) {
    await pivot(branchPoint, amount)
    await waitAngle(beforeCancel + amount, 1)
  }
  await page.mouse.up()
  await waitAngle(beforeCancel + 210, 1)
  await button('Undo').click()
  await waitAngle(beforeCancel, .1)

  await button('Save menu').click()
  await button('Save').click()
  await button('Save menu').getByText('Saved', { exact: true }).waitFor()
  await page.reload()
  await object.waitFor()
  await waitAngle(beforeCancel, .1)
  assert.deepEqual(errors, [])
  console.log(`Chrome ${browser.version()}: rotation kept its 30° press angle, +43° snapped to 75°, Alt +22° rotated freely, 30° snap also worked from the top target, Off crossed the angle branch cut, undo/redo each took one step, Escape canceled preview, and reload retained the saved angle. No page, console, or external request errors.`)
} finally {
  await browser.close()
}
