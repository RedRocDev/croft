import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [playwrightPath, chromePath, origin = 'http://localhost:5173'] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Run this crash test against Croft on localhost.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)

const testRoot = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
await mkdir(testRoot, { recursive: true })
const profile = await mkdtemp(path.join(testRoot, 'croft-browser-safety-'))
let context
const openProfile = () => chromium.launchPersistentContext(profile, {
  executablePath: chromePath,
  headless: true,
  chromiumSandbox: true,
  viewport: { width: 1440, height: 950 },
})

const read = (page, canvasId, objectId) => page.evaluate(async ({ id, object }) => {
  const { getProjects, getVersions, getRecoveries } = await import('/src/features/icanvas/storage.ts')
  const project = (await getProjects()).find(item => item.id === id)
  return {
    text: project.objects.find(item => item.id === object).text,
    versions: (await getVersions(id)).length,
    recoveries: (await getRecoveries(id)).length,
  }
}, { id: canvasId, object: objectId })

async function editText(page, id, value) {
  await page.getByTestId('canvas-object-' + id).press('Enter')
  const edit = page.getByRole('dialog', { name: 'Edit text' })
  await edit.locator('textarea').fill(value)
  await edit.getByRole('button', { name: 'Apply', exact: true }).click()
  await edit.waitFor({ state: 'hidden' })
}

async function waitForDraft(page, text) {
  await page.getByRole('region', { name: 'Canvas', exact: true }).getByText(text, { exact: true }).first().waitFor()
}

async function waitForSaved(page) {
  await page.getByRole('button', { name: 'Save menu', exact: true }).getByText('Saved', { exact: true }).waitFor()
}

async function waitForCrash(closed) {
  let timeout
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The deliberately crashed Chrome process did not close.')), 12_000)
    })])
  } finally {
    clearTimeout(timeout)
  }
}

try {
  context = await openProfile()
  let writer = context.pages()[0]
  writer.setDefaultTimeout(10_000)
  await writer.goto(origin)
  await writer.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).click()
  await waitForSaved(writer)
  const ids = await writer.evaluate(async () => {
    const { getProjects } = await import('/src/features/icanvas/storage.ts')
    const id = location.hash.split('/')[1]
    const project = (await getProjects()).find(item => item.id === id)
    return { canvasId: id, objectId: project.objects.find(item => item.kind === 'text').id }
  })

  const observer = await context.newPage()
  observer.setDefaultTimeout(10_000)
  await observer.goto(origin + '/#canvas/' + ids.canvasId)
  const access = observer.getByRole('button', { name: 'Enable editing', exact: true })
  await access.waitFor()
  assert.match(await observer.locator('.ic-access-banner').innerText(), /Read-only/i)
  const rejected = await observer.evaluate(async id => {
    const { getProjects, saveProjects } = await import('/src/features/icanvas/storage.ts')
    const project = (await getProjects()).find(item => item.id === id)
    try {
      await saveProjects([{ ...project, name: 'Blocked change', updatedAt: Date.now() + 10_000 }])
    } catch (error) {
      return String(error)
    }
    return 'Allowed'
  }, ids.canvasId)
  assert.match(rejected, /read-only/i)
  await access.click()
  await access.waitFor()
  await editText(writer, ids.objectId, 'Committed by the first tab')
  await writer.keyboard.press('Control+s')
  await waitForSaved(writer)
  assert.equal((await read(writer, ids.canvasId, ids.objectId)).text, 'Committed by the first tab')
  await writer.close()
  await observer.waitForFunction(async () => !(await navigator.locks.query()).held.some(lock => lock.name === 'croft-icanvas-writer'))
  await access.click()
  await access.waitFor({ state: 'hidden' })
  await waitForSaved(observer)
  await waitForDraft(observer, 'Committed by the first tab')
  writer = observer
  console.log('Two real tabs: reader blocked at storage, writer close released lease, promotion reloaded the committed predecessor state.')

  await writer.evaluate(async id => {
    const { getProjects, saveRecovery, saveVersion } = await import('/src/features/icanvas/storage.ts')
    const project = (await getProjects()).find(item => item.id === id)
    await saveRecovery(project)
    await saveVersion(project, 'Before persistence failure')
  }, ids.canvasId)
  const cdp = await context.newCDPSession(writer)
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(origin).origin, quotaSize: 0 })
  // Small IndexedDB row rewrites can reuse an existing LevelDB block and do not
  // invariably trigger quota accounting. Inject that precise exception at the
  // native put boundary for this single project's save when the browser permits it.
  const installQuotaFailure = () => writer.evaluate(id => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'projects' && value.id === id) throw new DOMException('Synthetic storage quota fault', 'QuotaExceededError')
      return original.call(this, value, ...args)
    }
    window.undoCroftQuotaFault = () => { IDBObjectStore.prototype.put = original }
  }, ids.canvasId)
  let quotaAllowed = false
  try {
    await writer.evaluate(async () => {
      const { createProject } = await import('/src/features/icanvas/model.ts')
      const { saveProjects } = await import('/src/features/icanvas/storage.ts')
      const probe = createProject('Quota allocation probe')
      const bytes = new Uint8Array(4 * 1024 * 1024)
      for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536))
      const asset = { id: crypto.randomUUID(), name: 'quota.bin', mime: 'application/octet-stream', size: bytes.length, blob: new Blob([bytes]) }
      const { makeObject } = await import('/src/features/icanvas/model.ts')
      probe.objects.push(makeObject('file', { x: 0, y: 0 }, { assetId: asset.id }))
      await saveProjects([probe], [asset])
    })
    quotaAllowed = true
  } catch (error) {
    if (!/Browser storage is full/.test(String(error))) throw error
  }
  const oversizedDraft = 'Draft retained after quota error. '.repeat(500)
  await installQuotaFailure()
  const failureMethod = quotaAllowed ? 'Injected quota error' : 'Browser quota cap and injected autosave quota error'
  await editText(writer, ids.objectId, oversizedDraft)
  const failed = writer.getByRole('button', { name: 'Save menu', exact: true }).getByText('Save failed', { exact: true })
  await failed.waitFor()
  await writer.getByText(/Browser storage is full/).first().waitFor()
  assert.equal(await writer.getByTestId('canvas-object-' + ids.objectId).locator('.ic-object-text').textContent(), oversizedDraft)
  assert.deepEqual(await read(writer, ids.canvasId, ids.objectId), { text: 'Committed by the first tab', versions: 1, recoveries: 1 })
  await writer.keyboard.press('Control+s')
  await failed.waitFor()
  assert.deepEqual(await read(writer, ids.canvasId, ids.objectId), { text: 'Committed by the first tab', versions: 1, recoveries: 1 })
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(origin).origin })
  await writer.evaluate(() => window.undoCroftQuotaFault())
  await writer.getByRole('button', { name: 'Retry', exact: true }).first().click()
  await waitForSaved(writer)
  assert.deepEqual(await read(writer, ids.canvasId, ids.objectId), { text: oversizedDraft, versions: 1, recoveries: 1 })
  console.log(`${failureMethod}: autosave and manual Save failed with explicit detail. Draft, old head and checkpoints stayed intact. Retry committed the draft without clearing recovery.`)

  const reverseFixture = await writer.evaluate(async id => {
    const { getProjects, saveProjects } = await import('/src/features/icanvas/storage.ts')
    const { makeObject } = await import('/src/features/icanvas/model.ts')
    const { createStack } = await import('/src/features/icanvas/stackScene.ts')
    const project = (await getProjects()).find(item => item.id === id)
    const front = makeObject('note', { x: 960, y: 85 }, { name: 'Save failure test card', visibleSide: 'back', back: { text: 'Committed reverse side' } })
    const rear = makeObject('note', { x: 1050, y: 200 }, { name: 'Save failure test rear', back: { text: 'Hidden reverse side' } })
    const { objects, stackId } = createStack([...project.objects, rear, front], [front.id, rear.id])
    await saveProjects([{ ...project, objects, updatedAt: Date.now() }])
    return { front: front.id, rear: rear.id, stack: stackId }
  }, ids.canvasId)
  await writer.reload()
  await waitForSaved(writer)
  const reverseReader = await context.newPage()
  await reverseReader.goto(writer.url())
  await reverseReader.getByRole('button', { name: 'Enable editing', exact: true }).waitFor()
  const readPile = page => page.evaluate(async ({ canvas, fixture }) => {
    const { getProjects } = await import('/src/features/icanvas/storage.ts')
    const { objects } = (await getProjects()).find(item => item.id === canvas)
    const byId = id => objects.find(item => item.id === id)
    return { order: byId(fixture.stack).stack.order, front: byId(fixture.front).back.text, rear: byId(fixture.rear).back.text }
  }, { canvas: ids.canvasId, fixture: reverseFixture })
  const pileBeforeFailure = await readPile(writer)
  await reverseReader.getByRole('button', { name: 'Browse 2 cards in Card stack', exact: true }).click()
  await reverseReader.getByRole('button', { name: 'Save failure test rear', exact: true }).click()
  await reverseReader.getByTestId('canvas-object-' + reverseFixture.rear).waitFor()
  assert.deepEqual(await readPile(reverseReader), pileBeforeFailure)
  await reverseReader.close()
  await installQuotaFailure()
  const reverseCard = writer.getByTestId('canvas-object-' + reverseFixture.front)
  await reverseCard.press('Enter')
  const reverseEditor = writer.getByRole('dialog', { name: 'Edit card back' })
  const pendingReverse = 'Pending reverse side survives write failure'
  await reverseEditor.getByRole('textbox', { name: 'Back text' }).fill(pendingReverse)
  await reverseEditor.getByRole('button', { name: 'Apply', exact: true }).click()
  await failed.waitFor()
  assert.equal(await reverseCard.getByText(pendingReverse, { exact: true }).count(), 1)
  assert.deepEqual(await readPile(writer), pileBeforeFailure)
  await writer.evaluate(() => window.undoCroftQuotaFault())
  await writer.getByRole('button', { name: 'Retry', exact: true }).first().click()
  await waitForSaved(writer)
  assert.deepEqual(await readPile(writer), { ...pileBeforeFailure, front: pendingReverse })
  console.log('Reader stack browsing stayed local. A failed pending Back edit retained the draft, stored order and both committed faces until Retry succeeded.')

  await writer.evaluate(async id => {
    const { getProjects, saveProjects } = await import('/src/features/icanvas/storage.ts')
    const project = (await getProjects()).find(item => item.id === id)
    const asset = { id: crypto.randomUUID(), name: 'rollback.txt', mime: 'text/plain', size: 1, blob: new Blob(['x'], { type: 'text/plain' }) }
    try {
      await saveProjects([{ ...project, parentId: id, updatedAt: Date.now() + 1 }], [asset])
    } catch (error) {
      if (!/SubCanvas/i.test(String(error))) throw error
      const { getAsset } = await import('/src/features/icanvas/storage.ts')
      if (await getAsset(asset.id)) throw new Error('A failed write retained an attachment.')
      return
    }
    throw new Error('The invalid hierarchy transaction unexpectedly committed.')
  }, ids.canvasId)

  await writer.clock.install()
  await editText(writer, ids.objectId, 'Never committed before crash')
  await waitForDraft(writer, 'Never committed before crash')
  await writer.clock.pauseAt(new Date(Date.now() + 10))
  const browserClosed = new Promise(resolve => context.once('close', resolve))
  const crash = await context.newCDPSession(writer)
  // Deliberate browser-process crash only inside this disposable synthetic profile.
  void crash.send('Browser.crash').catch(() => {})
  await waitForCrash(browserClosed)
  context = await openProfile()
  writer = context.pages().find(page => page.url().startsWith(origin)) ?? context.pages()[0]
  await writer.goto(origin + '/#canvas/' + ids.canvasId)
  await waitForSaved(writer)
  assert.deepEqual(await read(writer, ids.canvasId, ids.objectId), { text: oversizedDraft, versions: 1, recoveries: 1 })
  console.log('Abrupt Chrome process crash and new process on the same disposable profile: committed head, recovery, and version reopened; pre-autosave draft remained uncommitted.')
} finally {
  await context?.close()
  if (path.dirname(profile) === path.resolve(testRoot)) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}
