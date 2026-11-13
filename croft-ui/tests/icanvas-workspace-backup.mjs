import assert from 'node:assert/strict'
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const [playwrightPath, chromePath, origin = 'http://localhost:5173'] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
const address = new URL(origin)
assert.ok(['localhost', '127.0.0.1'].includes(address.hostname))
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const tempRoot = path.resolve(tmpdir())
const workspace = await mkdtemp(path.join(tempRoot, 'croft-backup-'))
const backupPath = path.join(workspace, 'portable.croftbackup')
const browser = await chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true })
const errors = []
const MiB = 1024 ** 2
const attachChecks = page => {
  page.setDefaultTimeout(12_000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== address.origin) errors.push(request.url())
  })
}

try {
  console.log('Chrome', browser.version())
  const source = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const page = await source.newPage()
  attachChecks(page)
  await page.goto(origin)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).waitFor()
  await page.evaluate(async () => {
    const store = await import('/src/features/icanvas/storage.ts')
    const { createProject, makeObject } = await import('/src/features/icanvas/model.ts')
    const bytes = new Uint8Array(44 * 1024 ** 2)
    bytes.fill(55)
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    const current = { id: 'synthetic-large-file', name: 'trail-kit.bin', mime: blob.type, size: blob.size, blob }
    const link = { id: 'synthetic-link', name: 'original-link.txt', mime: 'text/plain', size: 7, linked: true }
    const previous = { id: 'synthetic-history-file', name: 'backup-history.txt', mime: 'text/plain', size: 13, blob: new Blob(['draft history'], { type: 'text/plain' }) }
    const reverse = { id: 'synthetic-back-file', name: 'reverse.txt', mime: 'text/plain', size: 14, blob: new Blob(['back-only data'], { type: 'text/plain' }) }
    const board = createProject('Backup Expedition')
    const child = createProject('Backup Camps', board.id)
    const unopened = createProject('Backup Archived Plans')
    unopened.trashedAt = Date.now()
    const stack = makeObject('stack', { x: 10, y: 20 }, { name: 'Expedition stack' })
    const departure = makeObject('note', { x: 10, y: 20 }, { text: 'Departure', parentId: stack.id, visibleSide: 'back', back: { title: 'Route notes', text: 'Choose the trail.' } })
    const arrival = makeObject('canvas', { x: 350, y: 50 }, { name: child.name, targetId: child.id })
    const media = makeObject('file', { x: 0, y: 200 }, { name: current.name, assetId: current.id, parentId: stack.id,
      visibleSide: 'back', back: { title: 'File context', text: 'Open later.', assetId: reverse.id } })
    stack.stack = { order: [departure.id, media.id], layout: 'compact' }
    child.objects = [makeObject('file', { x: 0, y: 0 }, { name: link.name, assetId: link.id })]
    board.objects = [departure, arrival, media, stack]
    board.stops = [{ id: 'synthetic-stop', name: 'Stop', canvasId: child.id, camera: child.camera, duration: 5 }]
    board.edges = [{ id: 'synthetic-edge', kind: 'relationship', from: departure.id, to: arrival.id, label: 'Night 1' }]
    const older = { ...board, objects: [departure, arrival, { ...media, back: { ...media.back, assetId: previous.id } },
      { ...stack, stack: { order: [media.id, departure.id], layout: 'fan' } }] }
    await store.saveProjects([board, child, unopened], [current, link, previous, reverse])
    await store.saveVersion(older, 'Checkpoint with earlier attachment', [older, child])
    await store.saveRecovery({ ...older, name: 'Backup Expedition recovery test', updatedAt: board.updatedAt + 1 })
    await store.saveProjects([{ ...board, updatedAt: board.updatedAt + 2 }])
  })
  await page.reload()
  await page.getByRole('button', { name: 'Backup & restore', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Backup and restore workspace' })
  const summary = dialog.getByRole('region', { name: 'Workspace backup inventory' })
  await summary.getByText(/44\.0 MiB/).waitFor()
  await summary.getByText(/1 linked attachment requires relinking/).waitFor()
  // Headless Chrome has no native save dialog driver. Use a real Chrome file handle
  // when available, with OPFS providing a deterministic file-backed test destination.
  const metrics = await page.evaluateHandle(() => {
    const metrics = { chunks: 0, maxChunk: 0, total: 0, before: 0, peak: 0, measured: Boolean(performance.memory) }
    const usedHeap = () => performance.memory?.usedJSHeapSize ?? 0
    window.showSaveFilePicker = async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('backup-file', { create: true })
      return {
        async createWritable() {
          const stream = await handle.createWritable()
          metrics.before = usedHeap()
          metrics.peak = metrics.before
          return {
            async write(chunk) {
              metrics.chunks++
              metrics.total += chunk.byteLength
              metrics.maxChunk = Math.max(metrics.maxChunk, chunk.byteLength)
              metrics.peak = Math.max(metrics.peak, usedHeap())
              await stream.write(chunk)
              metrics.peak = Math.max(metrics.peak, usedHeap())
            },
            close: () => stream.close(), abort: () => stream.abort(),
          }
        },
      }
    }
    return metrics
  })
  // The component reads picker support on render, so reopen after setting the test picker.
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Backup & restore', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save backup…' }).click()
  await dialog.getByText('Workspace backup saved.').waitFor()
  const measurements = await metrics.jsonValue()
  assert.ok(measurements.chunks > 44)
  assert.ok(measurements.maxChunk <= MiB)
  console.log('Backup write metrics', JSON.stringify(measurements))
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async () => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle('backup-file')).getFile()
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.download = 'data.croftbackup'
      link.href = url
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }),
  ])
  await download.saveAs(backupPath)
  assert.ok((await stat(backupPath)).size > 44 * MiB)
  const sourceIds = await page.evaluate(async () => {
    const state = await (await import('/src/features/icanvas/storage.ts')).getWorkspaceStorageState()
    return state.projects.filter(project => project.name.startsWith('Backup ')).map(project => project.id)
  })
  const sourceSummary = () => page.evaluate(async () => {
    const state = await (await import('/src/features/icanvas/storage.ts')).getWorkspaceStorageState()
    return { ids: state.projects.map(project => project.id), size: state.assets.find(asset => asset.id === 'synthetic-large-file').blob.size,
      versions: state.versions.length, recoveries: state.recoveries.length }
  })
  const beforeFailedRestore = await sourceSummary()
  const incomplete = path.join(workspace, 'incomplete.croftbackup')
  const prefix = Buffer.alloc(64)
  const backupFile = await open(backupPath, 'r')
  try { await backupFile.read(prefix, 0, prefix.length, 0) } finally { await backupFile.close() }
  await writeFile(incomplete, prefix, { flag: 'wx' })
  await dialog.locator('input[type=file]').setInputFiles(incomplete)
  await dialog.getByRole('alert').filter({ hasText: 'incomplete' }).waitFor()
  assert.deepEqual(await sourceSummary(), beforeFailedRestore)
  await dialog.locator('input[type=file]').setInputFiles(backupPath)
  await dialog.getByRole('region', { name: 'Restore preview' }).getByText(/44\.0 MiB/).waitFor()
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  assert.deepEqual(await sourceSummary(), beforeFailedRestore)
  await source.close()

  const restored = await browser.newContext({ viewport: { width: 1440, height: 950 } })
  const dest = await restored.newPage()
  attachChecks(dest)
  await dest.goto(origin)
  await dest.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).waitFor()
  assert.equal(await dest.locator('.ic-project-open').filter({ hasText: 'Backup Expedition' }).count(), 0)
  await dest.getByRole('button', { name: 'Backup & restore', exact: true }).click()
  const restore = dest.getByRole('dialog', { name: 'Backup and restore workspace' })
  await restore.locator('input[type=file]').setInputFiles(backupPath)
  const preview = restore.getByRole('region', { name: 'Restore preview' })
  await preview.getByText(/44\.0 MiB/).waitFor()
  await preview.getByRole('button', { name: 'Restore as copies' }).click()
  await dest.locator('.ic-project-open').filter({ hasText: 'Backup Expedition' }).waitFor()
  const result = await dest.evaluate(async () => {
    const state = await (await import('/src/features/icanvas/storage.ts')).getWorkspaceStorageState()
    const parent = state.projects.find(project => project.name === 'Backup Expedition')
    const child = state.projects.find(project => project.name === 'Backup Camps')
    const old = state.projects.find(project => project.name === 'Backup Archived Plans')
    const attachment = state.assets.find(asset => asset.id === parent.objects[2].assetId)
    const link = state.assets.find(asset => asset.id === child.objects[0].assetId)
    const version = state.versions.find(entry => entry.projectId === parent.id)
    const recovery = state.recoveries.find(entry => entry.projectId === parent.id)
    const historyAsset = state.assets.find(asset => asset.id === version.project.objects[2].back.assetId)
    const reverseAsset = state.assets.find(asset => asset.id === parent.objects[2].back.assetId)
    return {
      ids: [parent.id, child.id, old.id],
      hierarchy: child.parentId === parent.id && parent.objects[1].targetId === child.id && parent.stops[0].canvasId === child.id,
      edges: parent.edges[0].kind === 'relationship' && parent.edges[0].from === parent.objects[0].id && parent.edges[0].to === parent.objects[1].id,
      trash: Boolean(old.trashedAt), media: attachment.blob.size, bytes: await attachment.blob.slice(-20).text(),
      link: link.linked && !link.blob && !link.handle, oldAttachment: await historyAsset.blob.text(),
      history: version.number === 1 && version.project.objects[2].id === parent.objects[2].id && version.descendants[0].id === child.id,
      recovery: recovery.project.objects[2].back.assetId === historyAsset.id,
      stack: parent.objects[3].stack.layout === 'compact' && parent.objects[3].stack.order.join(',') === [parent.objects[0].id, parent.objects[2].id].join(',') &&
        parent.objects[2].parentId === parent.objects[3].id && version.project.objects[3].stack.layout === 'fan' &&
        version.project.objects[3].stack.order.join(',') === [parent.objects[2].id, parent.objects[0].id].join(','),
      faces: parent.objects[2].visibleSide === 'back' && parent.objects[2].back.title === 'File context' && await reverseAsset.blob.text() === 'back-only data',
      starterCount: state.projects.filter(project => project.name === 'Holiday Ideas').length,
    }
  })
  assert.deepEqual(sourceIds.filter(id => result.ids.includes(id)), [])
  assert.deepEqual({ ...result, ids: undefined }, {
    ids: undefined, hierarchy: true, edges: true, trash: true, media: 44 * MiB, bytes: '7'.repeat(20),
    link: true, oldAttachment: 'draft history', history: true, recovery: true, stack: true, faces: true, starterCount: 2,
  })
  assert.deepEqual(errors, [])
  console.log('iCanvas workspace backup QA passed: real Chrome writable stream, fresh profile merge, 44 MiB media, face assets, visible sides, stack order, lineage, edges, links, Trash, versions and recovery.')
} finally {
  await browser.close()
  const target = path.resolve(workspace)
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('croft-backup-')) throw new Error('Unexpected cleanup target.')
  await rm(target, { recursive: true, force: true })
}
