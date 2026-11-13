import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

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

const closeTo = (actual, expected, tolerance, detail) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${detail}: expected ${expected} ± ${tolerance}, observed ${actual}`,
)
const quantile = (values, fraction) => {
  const sorted = [...values].sort((left, right) => left - right)
  return +sorted[Math.floor((sorted.length - 1) * fraction)].toFixed(2)
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, hasTouch: true, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) errors.push('External request: ' + request.url())
  })
  const button = name => page.getByRole('button', { name, exact: true })
  const stage = page.getByRole('region', { name: 'Canvas', exact: true })
  const world = stage.locator('.ic-world')

  async function waitZoom(expected) {
    await page.waitForFunction(zoom => {
      const world = document.querySelector('.ic-world')
      if (!world) return false
      return Math.abs(new DOMMatrix(getComputedStyle(world).transform).a - zoom) < 0.00001
    }, expected)
  }

  async function save() {
    await button('Save menu').click()
    await button('Save').click()
    await button('Save menu').getByText('Saved', { exact: true }).waitFor()
  }

  const readCamera = id => page.evaluate(async projectId => {
    const { getProjects } = await import('/src/features/icanvas/storage.ts')
    return (await getProjects()).find(project => project.id === projectId).camera
  }, id)

  async function waitForSavedCamera(id, zoom) {
    const deadline = performance.now() + 7000
    do {
      const camera = await readCamera(id)
      if (Math.abs(camera.zoom - zoom) < .0000001) return camera
      await new Promise(resolve => setTimeout(resolve, 80))
    } while (performance.now() < deadline)
    const camera = await readCamera(id)
    throw new Error(`Expected persisted zoom ${zoom}, read ${camera.zoom}. Browser errors: ${errors.join(', ')}`)
  }

  await page.goto(origin)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).waitFor()
  const fixtures = await page.evaluate(async () => {
    const { createProject, makeObject } = await import('/src/features/icanvas/model.ts')
    const { saveProjects } = await import('/src/features/icanvas/storage.ts')
    const scale = createProject('Scale fixture')
    scale.camera = { x: -40, y: -30, zoom: 1 }
    scale.settings.minimap = false
    const kinds = ['rectangle', 'ellipse', 'note', 'text', 'stroke']
    scale.objects = Array.from({ length: 1200 }, (_, index) => {
      const kind = kinds[index % kinds.length]
      return makeObject(kind, { x: 120 + (index % 40) * 190, y: 130 + Math.floor(index / 40) * 160 }, {
        name: `Bench ${index}`, text: `Bench ${index}`, rotation: index % 4 === 0 ? 18 : 0,
        width: 96, height: 76,
        ...(kind === 'stroke' ? { points: [{ x: 0, y: 10 }, { x: 48, y: 65 }, { x: 96, y: 8 }] } : {}),
      })
    })
    scale.edges = scale.objects.slice(1, 301).map((object, index) => ({
      id: crypto.randomUUID(), kind: index % 2 ? 'connection' : 'direction',
      from: scale.objects[index].id, to: object.id, label: '',
    }))

    const extremes = createProject('Far coordinate fixture')
    const x = 1_000_000_000
    const y = -2_000_000_000
    extremes.camera = { x: 450 - x, y: 350 - y, zoom: 1 }
    extremes.settings.snapGrid = false
    extremes.settings.snapObjects = false
    extremes.objects = [
      makeObject('rectangle', { x: x - 1, y: y - 1 }, { name: 'Precision target', width: 2, height: 2 }),
      makeObject('ellipse', { x: x + 12, y }, { name: 'Nearby precision object', width: 1, height: 1 }),
      makeObject('note', { x: -x, y: -y }, { name: 'Opposite quadrant object' }),
    ]
    extremes.edges = [{ id: crypto.randomUUID(), kind: 'direction', from: extremes.objects[0].id,
      to: extremes.objects[1].id, label: 'Far connector' }]
    await saveProjects([scale, extremes])
    return {
      scaleId: scale.id, extremeId: extremes.id, targetId: extremes.objects[0].id,
      anchor: { x, y }, benchCount: scale.objects.length, edgeCount: scale.edges.length,
    }
  })

  const start = performance.now()
  await page.goto(origin + '/?scale-test=1#canvas/' + fixtures.scaleId)
  await stage.waitFor()
  await page.locator('.ic-item[aria-label="Bench 0"]').waitFor()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const stageLoadMs = +(performance.now() - start).toFixed(1)
  const visibleAtStart = await stage.locator('.ic-item').count()
  assert.ok(visibleAtStart > 0 && visibleAtStart < fixtures.benchCount / 4,
    `Expected most offscreen objects to be culled; mounted ${visibleAtStart}.`)

  const bounds = await stage.boundingBox()
  assert.ok(bounds)
  const startX = bounds.x + 700
  const startY = bounds.y + 595
  await button('Hand').click()
  await page.mouse.move(startX, startY)
  await page.evaluate(() => {
    const state = { intervals: [], active: true }
    window.croftFrameProbe = state
    let previous = performance.now()
    function sample(now) {
      if (!state.active) return
      state.intervals.push(now - previous)
      previous = now
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const transformBeforePan = await world.evaluate(element => element.style.transform)
  await page.mouse.down()
  await page.mouse.move(startX - 520, startY - 255, { steps: 48 })
  await page.mouse.up()
  const intervals = await page.evaluate(() => {
    window.croftFrameProbe.active = false
    return window.croftFrameProbe.intervals.slice(1)
  })
  assert.ok(intervals.length >= 10, 'Frame sampler did not observe enough frames during pan.')
  assert.notEqual(await world.evaluate(element => element.style.transform), transformBeforePan)
  const visibleAfterPan = await stage.locator('.ic-item').count()
  assert.ok(visibleAfterPan > 0 && visibleAfterPan < fixtures.benchCount / 4)
  await button('Select').click()
  await save()
  const startingCamera = await readCamera(fixtures.scaleId)

  const session = await page.context().newCDPSession(page)
  const initial = { x: Math.round(bounds.x + 630), y: Math.round(bounds.y + 570) }
  const moved = { x: initial.x + 35, y: initial.y + 30 }
  function points(center, distance) {
    return [{ x: center.x - distance / 2, y: center.y, id: 0 }, { x: center.x + distance / 2, y: center.y, id: 1 }]
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(initial, 130) })
  for (const step of [.25, .5, .75, 1]) {
    const center = { x: initial.x + (moved.x - initial.x) * step, y: initial.y + (moved.y - initial.y) * step }
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(center, 130 + 130 * step) })
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await waitZoom(2)
  await save()
  const pinched = await readCamera(fixtures.scaleId)
  closeTo(pinched.zoom, 2, .001, 'Touch pinch zoom')
  for (const axis of ['x', 'y']) {
    const initialScreen = initial[axis] - bounds[axis]
    const movedScreen = moved[axis] - bounds[axis]
    const worldBefore = (initialScreen - startingCamera[axis]) / startingCamera.zoom
    const worldAfter = (movedScreen - pinched[axis]) / pinched.zoom
    closeTo(worldAfter, worldBefore, 2, 'Touch midpoint anchors world ' + axis)
  }

  const grip = button('Drag toolbar')
  const toolbar = page.locator('.ic-toolbar')
  const initialToolbar = await toolbar.boundingBox()
  const gripBounds = await grip.boundingBox()
  assert.ok(initialToolbar && gripBounds)
  await page.mouse.move(gripBounds.x + gripBounds.width / 2, gripBounds.y + gripBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(gripBounds.x + 135, gripBounds.y + 115, { steps: 9 })
  await page.mouse.up()
  const draggedToolbar = await toolbar.boundingBox()
  assert.ok(draggedToolbar)
  assert.ok(draggedToolbar.x - initialToolbar.x > 60 && draggedToolbar.y - initialToolbar.y > 60)
  await save()
  await page.reload()
  await stage.waitFor()
  await waitZoom(2)
  const reopenedToolbar = await toolbar.boundingBox()
  assert.ok(reopenedToolbar)
  closeTo(reopenedToolbar.x, draggedToolbar.x, 1, 'Saved toolbar x')
  closeTo(reopenedToolbar.y, draggedToolbar.y, 1, 'Saved toolbar y')

  await page.goto(origin + '/?scale-test=2#canvas/' + fixtures.extremeId)
  const target = page.getByTestId('canvas-object-' + fixtures.targetId)
  await target.waitFor()
  const farStage = await stage.boundingBox()
  assert.ok(farStage)
  const pixel = { x: farStage.x + 450, y: farStage.y + 350 }
  await page.mouse.move(pixel.x, pixel.y)
  await page.mouse.wheel(0, -10_000)
  await waitZoom(64)
  await button('Zoom settings').getByText('6400%', { exact: true }).waitFor()
  const transform = await world.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).toJSON())
  assert.ok(Math.abs(transform.e) < 1_000_000 && Math.abs(transform.f) < 1_000_000, 'Far camera must use a bounded compositor transform.')
  const farTarget = await target.boundingBox()
  assert.ok(farTarget)
  closeTo(farTarget.x + farTarget.width / 2, pixel.x, 2, 'Far object stays under zoom anchor (x)')
  closeTo(farTarget.y + farTarget.height / 2, pixel.y, 2, 'Far object stays under zoom anchor (y)')
  closeTo(farTarget.width, 128, 1, 'Far object retains its width at 6400%')
  await page.mouse.click(pixel.x, pixel.y)
  assert.equal(await target.getAttribute('data-selected'), 'true')
  const edge = stage.locator('[data-edge-kind="direction"] line').last()
  await edge.waitFor({ state: 'attached' })
  const endpoint = await edge.evaluate(line => {
    const screen = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(line.getScreenCTM())
    return { x: screen.x, y: screen.y }
  })
  closeTo(endpoint.x, pixel.x, 2, 'Rebased connector x')
  closeTo(endpoint.y, pixel.y, 2, 'Rebased connector y')
  const minimap = page.getByLabel('Canvas minimap', { exact: true })
  await minimap.waitFor()
  assert.ok((await minimap.locator('.ic-minimap-view').getAttribute('width')) > 0)
  await save()
  const maximum = await readCamera(fixtures.extremeId)
  closeTo(maximum.zoom, 64, .00001, 'Saved maximum zoom')
  closeTo((450 - maximum.x) / maximum.zoom, fixtures.anchor.x, .01, 'Far world position x')
  closeTo((350 - maximum.y) / maximum.zoom, fixtures.anchor.y, .01, 'Far world position y')

  await page.mouse.move(pixel.x, pixel.y)
  await page.mouse.wheel(0, 20_000)
  await waitZoom(.0025)
  await button('Zoom settings').getByText('0.25%', { exact: true }).waitFor()
  const minimum = await waitForSavedCamera(fixtures.extremeId, .0025)
  closeTo(minimum.zoom, .0025, .0000001, 'Saved minimum zoom')
  closeTo((450 - minimum.x) / minimum.zoom, fixtures.anchor.x, .01, 'Min zoom world position x')
  closeTo((350 - minimum.y) / minimum.zoom, fixtures.anchor.y, .01, 'Min zoom world position y')
  const mapBox = await minimap.boundingBox()
  assert.ok(mapBox)
  await page.mouse.click(mapBox.x + mapBox.width * .28, mapBox.y + mapBox.height * .31)
  const recentered = await world.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).toJSON())
  assert.ok(Number.isFinite(recentered.e) && Number.isFinite(recentered.f))
  assert.deepEqual(errors, [])

  console.log(JSON.stringify({
    chrome: browser.version(), viewport: '1440x950', objects: fixtures.benchCount, edges: fixtures.edgeCount,
    stageLoadMs, visibleAtStart, visibleAfterPan, panFrameSamples: intervals.length,
    panFrameP50Ms: quantile(intervals, .5), panFrameP95Ms: quantile(intervals, .95),
    panFrameMaxMs: +Math.max(...intervals).toFixed(2),
    pinch: 'CDP two-finger 100% to 200%, translated midpoint preserves anchored world point',
    zoom: '0.25%–6400%, precise far-object hit testing at world x=1e9, y=-2e9',
    toolbar: 'mouse drag, save, and reload preserved its position',
    errors: errors.length,
  }, null, 2))
} finally {
  await browser.close()
}
