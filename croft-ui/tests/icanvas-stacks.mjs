import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const [playwrightPath, chromePath, originArgument] = process.argv.slice(2)
const origin = new URL(originArgument || process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Use a local Croft origin.')
const { chromium } = require(playwrightPath || process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const executablePath = chromePath || process.env.CROFT_QA_CHROME
const screenshots = process.env.CROFT_QA_SCREENSHOTS ? resolve(process.env.CROFT_QA_SCREENSHOTS) : undefined
if (screenshots) await mkdir(screenshots, { recursive: true })
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  headless: true,
  chromiumSandbox: true,
})

const closeTo = (actual, expected, tolerance, detail) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `${detail}: expected ${expected} ± ${tolerance}, observed ${actual}`,
)

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
  const stage = page.getByRole('region', { name: 'Canvas', exact: true })
  const item = id => page.getByTestId('canvas-object-' + id)
  const count = amount => button(`Browse ${amount} ${amount === 1 ? 'card' : 'cards'} in Card stack`)
  const capture = name => screenshots
    ? page.screenshot({ path: resolve(screenshots, 'icanvas-stacks-' + name + '.png'), animations: 'disabled' })
    : undefined
  async function center(locator) {
    const rect = await locator.boundingBox()
    assert.ok(rect)
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  }
  async function startDrag(locator) {
    const point = await center(locator)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    return point
  }
  async function save() {
    await button('Save menu').click()
    await button('Save').click()
    await button('Save menu').getByText('Saved', { exact: true }).waitFor()
  }
  const read = id => page.evaluate(async projectId => {
    const { getProjects } = await import('/src/features/icanvas/storage.ts')
    return (await getProjects()).find(project => project.id === projectId)
  }, id)

  await page.goto(origin)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).waitFor()
  const fixture = await page.evaluate(async () => {
    const { createProject, makeObject } = await import('/src/features/icanvas/model.ts')
    const { saveProjects } = await import('/src/features/icanvas/storage.ts')
    const { createStack } = await import('/src/features/icanvas/stackScene.ts')
    const project = createProject('Desk test fixture')
    project.camera = { x: 25, y: 45, zoom: 1 }
    project.settings = { ...project.settings, minimap: false, snapGrid: false, snapObjects: false, panel: 'closed' }
    const canvas = document.createElement('canvas')
    canvas.width = 96
    canvas.height = 64
    const painter = canvas.getContext('2d')
    painter.fillStyle = '#405f54'
    painter.fillRect(0, 0, 96, 64)
    painter.fillStyle = '#ead4af'
    painter.fillRect(18, 16, 60, 32)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const image = { id: crypto.randomUUID(), name: 'Fixture.png', mime: blob.type, size: blob.size, blob }
    const notes = [
      makeObject('note', { x: 140, y: 250 }, { name: 'Atlas', text: 'Atlas front', visibleSide: 'back',
        back: { title: 'Atlas reverse', text: 'Keep this side on Atlas.' }, width: 170, height: 145 }),
      makeObject('note', { x: 355, y: 250 }, { name: 'Birch', text: 'Birch front',
        back: { title: 'Birch reverse', text: 'occluded-amber-sparrow' }, width: 185, height: 138, rotation: 8 }),
      makeObject('image', { x: 580, y: 250 }, { name: 'Cinema', mode: 'card', width: 180, height: 145, assetId: image.id,
        back: { title: 'Cinema reverse', text: 'Image card supplement' } }),
      makeObject('note', { x: 815, y: 255 }, { name: 'Dune', text: 'Dune front',
        back: { title: 'Dune reverse', text: 'Desk test front-only flip' }, width: 190, height: 155 }),
    ]
    const loose = makeObject('note', { x: 190, y: 570 }, { name: 'Echo', text: 'Loose overlap test', width: 160, height: 135 })
    const linked = makeObject('rectangle', { x: 1090, y: 520 }, { name: 'Edge endpoint', width: 35, height: 30 })
    project.objects = [...notes, loose, linked]
    project.edges = [{ id: crypto.randomUUID(), kind: 'direction', from: notes[1].id, to: linked.id, label: 'Birch link' }]

    const large = createProject('Large pile fixture')
    large.camera = { x: 20, y: 35, zoom: 1 }
    large.settings = { ...large.settings, minimap: false }
    const many = Array.from({ length: 260 }, (_, index) =>
      makeObject('image', { x: index * 5, y: 200 }, { name: 'Media card ' + index, mode: 'card', assetId: image.id }))
    large.objects = createStack(many, many.map(object => object.id)).objects
    await saveProjects([project, large], [image])
    return { projectId: project.id, largeId: large.id, ids: notes.map(object => object.id), loose: loose.id, edge: project.edges[0] }
  })

  const [atlas, birch, cinema, dune] = fixture.ids
  const url = origin + '/?stacks-test=1#canvas/' + fixture.projectId
  await page.goto(url)
  await stage.waitFor()
  await item(atlas).waitFor()
  await item(atlas).click()
  await page.keyboard.down('Shift')
  try {
    await item(birch).click()
    // Media pixels accept a normal object selection; native controls use separate targets.
    await item(cinema).click({ position: { x: 24, y: 20 } })
    await item(dune).click()
  } finally {
    await page.keyboard.up('Shift')
  }
  await page.getByRole('toolbar', { name: 'Selection actions' }).getByRole('button', { name: 'Stack Cards', exact: true }).click()
  await count(4).waitFor()
  await item(atlas).waitFor({ state: 'detached' })
  await item(birch).waitFor({ state: 'detached' })
  await item(cinema).waitFor({ state: 'detached' })
  await item(dune).waitFor()
  assert.equal(await stage.locator('.ic-stack-rear').count(), 3)
  await capture('compact')
  await button('Undo').click()
  await count(4).waitFor({ state: 'detached' })
  for (const id of fixture.ids) await item(id).waitFor()
  await button('Redo').click()
  await count(4).waitFor()

  const duneFlip = item(dune).getByRole('button', { name: 'Show back of card', exact: true })
  await duneFlip.focus()
  await duneFlip.click()
  assert.equal(await item(dune).getAttribute('data-card-side'), 'front')
  await duneFlip.dblclick()
  assert.equal(await item(dune).getAttribute('data-card-side'), 'back')
  await item(dune).getByText('Dune reverse', { exact: true }).waitFor()
  await capture('back')
  await count(4).click()
  const members = page.locator('.ic-stack-member-popover')
  await members.waitFor()
  assert.deepEqual((await members.getByRole('button').allTextContents()).slice(0, 4), ['Dune', 'Cinema', 'Birch', 'Atlas'])
  await capture('members')
  await members.getByRole('button', { name: 'Atlas', exact: true }).click()
  await item(atlas).waitFor()
  assert.equal(await item(atlas).getAttribute('data-card-side'), 'back')

  const edge = button('Bring forward Cinema')
  await edge.focus()
  await edge.press('Enter')
  await item(cinema).waitFor()
  const media = item(cinema).getByRole('img', { name: 'Cinema', exact: true })
  await media.waitFor()
  await media.evaluate(image => image.decode())
  assert.deepEqual(await media.evaluate(image => [image.naturalWidth, image.naturalHeight]), [96, 64])
  assert.equal(await item(cinema).getAttribute('data-card-side'), 'front')
  const quickBounds = await page.getByRole('toolbar', { name: 'Selection actions' }).boundingBox()
  const pileControlsBounds = await page.locator('.ic-stack-controls').boundingBox()
  assert.ok(quickBounds && pileControlsBounds)
  assert.ok(quickBounds.y + quickBounds.height <= pileControlsBounds.y || pileControlsBounds.y + pileControlsBounds.height <= quickBounds.y,
    'The card selection toolbar must not cover the pile controls.')
  await capture('front')

  if (screenshots) {
    await button('View').click()
    await button('Show inspector').click()
    const inspector = page.getByRole('complementary', { name: 'Canvas inspector' })
    await inspector.getByRole('button', { name: 'Layers', exact: true }).click()
    const layers = inspector.getByRole('list', { name: 'Canvas layers' })
    for (const name of ['Card stack', 'Atlas', 'Birch', 'Cinema', 'Dune']) {
      await layers.getByRole('button', { name, exact: true }).waitFor()
    }
    await capture('layers')
    await inspector.getByRole('button', { name: 'Close inspector', exact: true }).click()
  }

  await save()
  const beforeMove = await read(fixture.projectId)
  const stack = beforeMove.objects.find(object => object.kind === 'stack')
  assert.ok(stack)
  assert.deepEqual(beforeMove.edges, [fixture.edge])
  assert.equal(beforeMove.objects.find(object => object.id === atlas).visibleSide, 'back')
  assert.equal(beforeMove.objects.find(object => object.id === dune).visibleSide, 'back')
  assert.equal(beforeMove.objects.find(object => object.id === birch).visibleSide ?? 'front', 'front')
  const moveFrom = await startDrag(button('Move stack Card stack'))
  await page.mouse.move(moveFrom.x - 115, moveFrom.y + 87, { steps: 10 })
  await page.mouse.up()
  await save()
  const moved = await read(fixture.projectId)
  const movedStack = moved.objects.find(object => object.id === stack.id)
  closeTo(movedStack.x - stack.x, -115, 1, 'stack x offset')
  closeTo(movedStack.y - stack.y, 87, 1, 'stack y offset')
  for (const id of fixture.ids) {
    const before = beforeMove.objects.find(object => object.id === id)
    const after = moved.objects.find(object => object.id === id)
    closeTo(after.x - before.x, -115, 1, 'member x offset')
    closeTo(after.y - before.y, 87, 1, 'member y offset')
  }

  const overlapAt = await center(item(cinema))
  await startDrag(item(fixture.loose))
  await page.mouse.move(overlapAt.x, overlapAt.y, { steps: 12 })
  await page.mouse.up()
  await count(4).waitFor()
  await save()
  const beforeCancelledDrop = (await read(fixture.projectId)).objects.find(object => object.id === fixture.loose)
  assert.equal(beforeCancelledDrop.parentId, undefined)
  const drop = stage.locator('[data-add-to-stack]')
  async function aimDrop() {
    const from = await startDrag(item(fixture.loose))
    await page.mouse.move(from.x + 5, from.y + 5, { steps: 3 })
    await drop.waitFor()
    const destination = await center(drop)
    await page.mouse.move(destination.x, destination.y, { steps: 15 })
    assert.equal(await drop.getAttribute('data-active'), 'true')
  }
  await aimDrop()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await count(4).waitFor()
  await save()
  assert.deepEqual((await read(fixture.projectId)).objects.find(object => object.id === fixture.loose), beforeCancelledDrop)
  await aimDrop()
  await page.mouse.up()
  await count(5).waitFor()
  await item(fixture.loose).waitFor()
  await save()
  assert.equal((await read(fixture.projectId)).objects.find(object => object.id === fixture.loose).parentId, stack.id)

  const extract = await startDrag(button('Extract Echo'))
  await page.mouse.move(extract.x - 390, extract.y + 170, { steps: 15 })
  await page.mouse.up()
  await count(4).waitFor()
  await save()
  const extracted = await read(fixture.projectId)
  assert.equal(extracted.objects.find(object => object.id === fixture.loose).parentId, undefined)
  assert.equal(new Set(extracted.objects.map(object => object.id)).size, extracted.objects.length)

  await count(4).click()
  await members.getByRole('button', { name: 'Fan Out', exact: true }).click()
  await button('Fit All').click()
  for (const id of fixture.ids) await item(id).waitFor()
  assert.equal(await stage.locator('.ic-stack-rear').count(), 0)
  await capture('fan')
  await save()
  const fanned = await read(fixture.projectId)
  const fannedOrder = fanned.objects.find(object => object.id === stack.id).stack.order
  const fannedMember = item(fannedOrder[1])
  const boundsBeforeFlip = await fannedMember.boundingBox()
  await fannedMember.locator('.ic-card-flip').press('Enter')
  await save()
  assert.deepEqual(await fannedMember.boundingBox(), boundsBeforeFlip)
  assert.deepEqual((await read(fixture.projectId)).objects.find(object => object.id === stack.id).stack.order, fannedOrder)
  await fannedMember.locator('.ic-card-flip').press('Enter')
  const frontBeforeEdit = fanned.objects.find(object => object.id === dune)
  if (await item(dune).getAttribute('data-card-side') === 'back') await item(dune).locator('.ic-card-flip').press('Enter')
  await item(dune).press('Enter')
  const editFront = page.getByRole('dialog', { name: 'Edit sticky note', exact: true })
  await editFront.locator('textarea').fill('Edited Front in fan mode')
  await editFront.getByRole('button', { name: 'Apply', exact: true }).click()
  await save()
  assert.deepEqual((await read(fixture.projectId)).objects.find(object => object.id === dune), {
    ...frontBeforeEdit, text: 'Edited Front in fan mode', visibleSide: 'front',
  })
  await count(4).click()
  await members.getByRole('button', { name: 'Restack', exact: true }).click()
  assert.equal(await stage.locator('.ic-item[data-stack-member="true"]').count(), 1)

  await page.getByRole('button', { name: 'Project menu', exact: true }).click()
  await button('Find in canvas').click()
  const find = page.getByRole('dialog', { name: 'Find in canvas', exact: true })
  await find.getByRole('textbox', { name: 'Search', exact: true }).fill('occluded-amber-sparrow')
  await find.getByRole('button', { name: /Birch reverse.*Card stack.*Back/ }).click()
  await item(birch).waitFor()
  assert.equal(await item(birch).getAttribute('data-card-side'), 'back')
  await item(birch).getByText('occluded-amber-sparrow').waitFor()
  await save()
  await page.reload()
  await count(4).waitFor()
  await item(birch).waitFor()
  assert.equal(await item(birch).getAttribute('data-card-side'), 'back')

  await count(4).click()
  await members.getByRole('button', { name: 'Delete stack…', exact: true }).click()
  const deleteStack = page.getByRole('dialog', { name: 'Delete card stack' })
  await deleteStack.getByRole('button', { name: 'Cancel', exact: true }).click()
  await count(4).waitFor()
  await count(4).click()
  await members.getByRole('button', { name: 'Delete stack…', exact: true }).click()
  await deleteStack.getByRole('button', { name: 'Delete stack and its cards', exact: true }).click()
  await count(4).waitFor({ state: 'detached' })
  await save()
  const deleted = await read(fixture.projectId)
  assert.equal(deleted.objects.some(object => object.id === stack.id || fixture.ids.includes(object.id)), false)
  assert.equal(deleted.objects.some(object => object.id === fixture.loose), true)
  assert.equal(deleted.edges.length, 0)
  await button('Undo').click()
  await count(4).waitFor()
  await item(birch).waitFor()

  await button('Save menu').click()
  await button('Save VC').click()
  const checkpoint = page.getByRole('dialog', { name: 'Save VC' })
  await checkpoint.getByLabel('Version notes (optional)').fill('Keep the stack')
  await checkpoint.getByRole('button', { name: 'Save version', exact: true }).click()
  await checkpoint.waitFor({ state: 'hidden' })
  const checkpointHead = await read(fixture.projectId)
  const order = checkpointHead.objects.find(object => object.id === stack.id).stack.order
  assert.equal(order[0], birch)
  await count(4).click()
  await members.getByRole('button', { name: 'Dune', exact: true }).click()
  await item(dune).waitFor()
  const duneSide = await item(dune).getAttribute('data-card-side')
  await item(dune).locator('.ic-card-flip').press('Enter')
  assert.equal(await item(dune).getAttribute('data-card-side'), duneSide === 'back' ? 'front' : 'back')
  await button('Project menu').click()
  await button('Version History').click()
  const history = page.getByRole('dialog', { name: 'Version history' })
  await history.getByRole('button', { name: /v1.*Keep the stack/ }).click()
  await history.getByRole('button', { name: 'Restore…', exact: true }).click()
  await history.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await history.waitFor({ state: 'hidden' })
  await item(birch).waitFor()
  const restored = await read(fixture.projectId)
  assert.deepEqual(restored.objects.find(object => object.id === stack.id).stack.order, order)
  assert.equal(restored.objects.find(object => object.id === dune).visibleSide, duneSide)
  assert.equal(restored.objects.find(object => object.id === birch).back.text, 'occluded-amber-sparrow')
  assert.deepEqual(restored.edges, [fixture.edge])

  await button('Save menu').click()
  await button('Save As…').click()
  const saveAs = page.getByRole('dialog', { name: 'Save As…' })
  await saveAs.getByLabel('Name', { exact: true }).fill('Desk test copy')
  await saveAs.getByRole('button', { name: 'Create copy', exact: true }).click()
  await saveAs.waitFor({ state: 'hidden' })
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByText('Desk test copy', { exact: true }).waitFor()
  const details = page.getByRole('dialog', { name: 'Project Details' })
  if (await details.count()) await details.getByRole('button', { name: 'Cancel', exact: true }).click()
  await count(4).waitFor()
  const copyId = new URL(page.url()).hash.split('/')[1]
  const copied = await read(copyId)
  const copiedStack = copied.objects.find(object => object.kind === 'stack')
  assert.notEqual(copiedStack.id, stack.id)
  const copiedOrder = copiedStack.stack.order.map(id => copied.objects.find(object => object.id === id))
  assert.deepEqual(copiedOrder.map(object => object.name), order.map(id => restored.objects.find(object => object.id === id).name))
  assert.ok(copiedOrder.every(object => object.parentId === copiedStack.id && !fixture.ids.includes(object.id)))
  const copiedBirch = copiedOrder.find(object => object.name === 'Birch')
  assert.equal(copied.edges[0].from, copiedBirch.id)
  assert.equal(copiedBirch.back.text, 'occluded-amber-sparrow')
  assert.equal(copiedOrder.find(object => object.name === 'Cinema').assetId, restored.objects.find(object => object.id === cinema).assetId)
  await item(copiedBirch.id).getByRole('button', { name: 'Show front of card', exact: true }).press('Enter')
  await save()
  assert.equal((await read(copyId)).objects.find(object => object.id === copiedBirch.id).visibleSide, 'front')
  assert.equal((await read(fixture.projectId)).objects.find(object => object.id === birch).visibleSide, 'back')
  await page.goto(origin + '/?stacks-test=3#canvas/' + fixture.projectId)
  await count(4).waitFor()

  await count(4).click()
  await members.getByRole('button', { name: 'Unstack All', exact: true }).click()
  await count(4).waitFor({ state: 'detached' })
  await save()
  const unstacked = await read(fixture.projectId)
  assert.equal(unstacked.objects.some(object => object.kind === 'stack'), false)
  assert.ok(fixture.ids.every(id => unstacked.objects.some(object => object.id === id && !object.parentId)))
  assert.deepEqual(unstacked.edges, [fixture.edge])
  await button('Undo').click()
  await count(4).waitFor()
  await button('Redo').click()
  await count(4).waitFor({ state: 'detached' })
  await save()
  await page.reload()
  const reopened = await read(fixture.projectId)
  assert.deepEqual(reopened.objects.map(object => object.id).sort(), unstacked.objects.map(object => object.id).sort())
  assert.deepEqual(reopened.edges, [fixture.edge])

  await page.goto(origin + '/?stacks-test=2#canvas/' + fixture.largeId)
  await count(260).waitFor()
  assert.equal(await stage.locator('.ic-item[data-stack-member="true"]').count(), 1)
  assert.equal(await stage.locator('.ic-stack-rear').count(), 3)
  assert.equal(await stage.locator('.ic-item[data-stack-member="true"] img').count(), 1)
  await count(260).click()
  assert.equal(await members.getByRole('button', { name: /^Media card \d+$/ }).count(), 260)
  assert.deepEqual(errors, [])
  console.log(`Chrome ${browser.version()}: 4-card stack + media, compact/side/edge and list browsing, separate card and pile controls, move, ordinary overlap, deliberate add and Escape cancellation, extraction, fan/restack, Back search, delete/cancel/undo, Save VC restore, independent Save As, unstack/undo/redo and reload all verified. A compact 260-image pile mounted one real media face and three rear silhouettes; all 260 members listed. Zero page, console, and external request errors.`)
} finally {
  await browser.close()
}
