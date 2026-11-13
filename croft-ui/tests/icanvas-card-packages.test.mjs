import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { cardFace, cardSide, createProject, makeObject } from '../src/features/icanvas/model.ts'
import { importProject, makeProjectPackage, renderProjectSvg } from '../src/features/icanvas/portability.ts'
import { cloneProjectTree } from '../src/features/icanvas/storage.ts'
import { cloneWorkspaceBackup, inspectWorkspaceBackup, parseWorkspaceBackup, streamWorkspaceBackup } from '../src/features/icanvas/workspaceBackup.ts'

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/s4sAAAAASUVORK5CYII=', 'base64')
const decode = new TextDecoder()

function fixture() {
  const project = createProject('Card portability')
  const frame = makeObject('frame', { x: 40, y: 50 }, { width: 650, height: 420, rotation: 16 })
  const stack = makeObject('stack', { x: 70, y: 90 }, { parentId: frame.id, width: 255, height: 240, rotation: 17, name: 'Clip stack' })
  const image = makeObject('image', { x: 125, y: 140 }, { mode: 'card', name: 'Image front', parentId: stack.id, assetId: 'original', visibleSide: 'back',
    back: { title: 'Private reverse', text: 'See the route', assetId: 'pixels' } })
  const hidden = makeObject('note', { x: 230, y: 228 }, { parentId: stack.id, name: 'Second member', text: 'Rear note', visibleSide: 'back',
    back: { title: 'Rear reverse', text: 'Rest when needed', assetId: 'hidden-file' } })
  const loose = makeObject('note', { x: 470, y: 160 }, { name: 'Loose card', text: 'Loose card face' })
  stack.stack = { order: [image.id, hidden.id], layout: 'compact' }
  project.objects = [frame, stack, image, hidden, loose]
  project.edges = [{ id: 'card-edge', kind: 'connection', from: hidden.id, to: loose.id, label: 'Rear endpoint' }]
  const files = [
    { id: 'original', name: 'front.png', mime: 'image/png', size: pixels.length, blob: new Blob([pixels], { type: 'image/png' }) },
    { id: 'pixels', name: 'back.png', mime: 'image/png', size: pixels.length, blob: new Blob([pixels], { type: 'image/png' }) },
    { id: 'hidden-file', name: 'hidden.txt', mime: 'text/plain', size: 4, blob: new Blob(['rear'], { type: 'text/plain' }) },
  ]
  return { project, files }
}

const kind = (project, kind) => project.objects.find(object => object.kind === kind)

test('editable v2 preserves both sides, ordered members, scoped selection, connections, and hidden attachment bytes', async () => {
  const { project, files } = fixture()
  const file = await makeProjectPackage([project], project.id, {}, files)
  const zipped = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifest = JSON.parse(decode.decode(zipped['manifest.json']))
  assert.equal(manifest.version, 2)
  const { projects: [copy], assets } = await importProject(file)
  const pile = kind(copy, 'stack')
  const front = kind(copy, 'image')
  const obscured = copy.objects.find(item => item.name === 'Second member')
  assert.notEqual(pile.id, kind(project, 'stack').id)
  assert.equal(pile.parentId, kind(copy, 'frame').id)
  assert.deepEqual(pile.stack, { layout: 'compact', order: [front.id, obscured.id] })
  assert.equal(front.parentId, pile.id)
  assert.equal(obscured.parentId, pile.id)
  assert.equal(copy.edges[0].from, obscured.id)
  assert.equal(cardSide(front), 'back')
  assert.equal(cardFace(front).title, 'Private reverse')
  assert.equal(cardFace(front, 'front').title, 'Image front')
  assert.deepEqual(Buffer.from(await assets.find(asset => asset.id === front.back.assetId).blob.arrayBuffer()), pixels)
  assert.equal(await assets.find(asset => asset.id === obscured.back.assetId).blob.text(), 'rear')
  assert.notEqual(front.back.assetId, front.assetId)

  const selected = await importProject(await makeProjectPackage([project], project.id,
    { scope: 'selection', selectedIds: [kind(project, 'stack').id] }, files))
  assert.equal(selected.projects[0].objects.length, 3)
  assert.equal(kind(selected.projects[0], 'stack').parentId, undefined)
  assert.equal(kind(selected.projects[0], 'stack').stack.order.length, 2)
  const onlyRear = await importProject(await makeProjectPackage([project], project.id,
    { scope: 'selection', selectedIds: [project.objects[3].id] }, files))
  assert.equal(onlyRear.projects[0].objects.length, 1)
  assert.equal(onlyRear.projects[0].objects[0].parentId, undefined)
  assert.equal(cardFace(onlyRear.projects[0].objects[0]).title, 'Rear reverse')

  const wrongVersion = { ...manifest, version: 1 }
  await assert.rejects(importProject(new Blob([zipSync({ ...zipped, 'manifest.json': strToU8(JSON.stringify(wrongVersion)) }, { level: 0 })])), /version 2/)
  const missingMember = structuredClone(manifest)
  kind(missingMember.projects[0], 'stack').stack.order.pop()
  await assert.rejects(importProject(new Blob([zipSync({ ...zipped, 'manifest.json': strToU8(JSON.stringify(missingMember)) }, { level: 0 })])), /missing from its stack order/)
})

test('Save As and v2 workspace restore consistently remap stack cards and historical face assets', async () => {
  const { project, files } = fixture()
  const [savedAs] = cloneProjectTree([project], project.id, 'Independent copy')
  const copyStack = kind(savedAs, 'stack')
  assert.equal(copyStack.stack.order[0], kind(savedAs, 'image').id)
  assert.equal(kind(savedAs, 'image').back.assetId, 'pixels')
  kind(savedAs, 'image').back.text = 'Independent reverse'
  assert.equal(kind(project, 'image').back.text, 'See the route')

  const prior = structuredClone(project)
  kind(prior, 'stack').stack.layout = 'fan'
  kind(prior, 'stack').stack.order.reverse()
  const historyBytes = new Blob(['prior notes'], { type: 'text/plain' })
  kind(prior, 'image').back.assetId = 'history-only'
  const state = {
    projects: [project], assets: [...files, { id: 'history-only', name: 'prior.txt', mime: historyBytes.type, size: historyBytes.size, blob: historyBytes }],
    versions: [{ id: 'version', projectId: project.id, project: prior, createdAt: Date.now(), number: 1, notes: 'Prior order', descendants: [] }],
    recoveries: [{ id: 'recovery', projectId: project.id, project: prior, createdAt: Date.now() }],
  }
  assert.equal(inspectWorkspaceBackup(state).orphans, 0)
  const chunks = []
  await streamWorkspaceBackup(state, { async write(bytes) { chunks.push(bytes.slice()) } })
  assert.equal(decode.decode(chunks[0]), 'CROFT WORKSPACE BACKUP 2\n')
  const copy = cloneWorkspaceBackup(await parseWorkspaceBackup(new Blob(chunks)))
  const [restored] = copy.projects
  const [version] = copy.versions
  assert.equal(version.projectId, restored.id)
  assert.equal(kind(version.project, 'stack').id, kind(restored, 'stack').id)
  assert.deepEqual(kind(version.project, 'stack').stack.order, [...kind(restored, 'stack').stack.order].reverse())
  assert.equal(kind(copy.recoveries[0].project, 'stack').stack.layout, 'fan')
  const oldAsset = copy.assets.find(asset => asset.id === kind(version.project, 'image').back.assetId)
  assert.equal(await oldAsset.blob.text(), 'prior notes')
  assert.equal(await copy.assets.find(asset => asset.id === kind(restored, 'image').back.assetId).blob.arrayBuffer().then(bytes => Buffer.from(bytes).toString('hex')), pixels.toString('hex'))
  await assert.rejects(parseWorkspaceBackup(new Blob(['CROFT WORKSPACE BACKUP 1\n', ...chunks.slice(1)])), /version 2/)
})

test('static output renders the displayed face, compact stack and fan while preserving endpoint visibility', async () => {
  const { project, files } = fixture()
  const compact = await (await renderProjectSvg(project, {}, files)).blob.text()
  assert.match(compact, /Private reverse/)
  assert.match(compact, /data:image\/png;base64/)
  assert.match(compact, /data-stack-rear="true"/)
  assert.match(compact, /Rear endpoint/)
  assert.match(compact, /rotate\(/)
  assert.doesNotMatch(compact, /Image front|Rear reverse|Rear note|NaN/)
  kind(project, 'stack').stack.layout = 'fan'
  const fan = await (await renderProjectSvg(project, {}, files)).blob.text()
  assert.match(fan, /Private reverse/)
  assert.match(fan, /Rear reverse/)
  assert.doesNotMatch(fan, /data-stack-rear="true"/)
  kind(project, 'frame').collapsed = true
  const folded = await (await renderProjectSvg(project, {}, files)).blob.text()
  assert.doesNotMatch(folded, /Private reverse|Rear reverse|Rear endpoint|data-stack-rear="true"/)
})

test('legacy single-sided project emits v1 and loads its existing Front with an empty Back', async () => {
  const legacy = createProject('Single-sided legacy canvas')
  legacy.objects = [makeObject('note', { x: 5, y: 12 }, { name: 'Original note', text: 'Front text' })]
  const zipped = await makeProjectPackage([legacy], legacy.id)
  const payload = unzipSync(new Uint8Array(await zipped.arrayBuffer()))
  assert.equal(JSON.parse(decode.decode(payload['manifest.json'])).version, 1)
  const { projects: [project] } = await importProject(zipped)
  const note = kind(project, 'note')
  assert.equal(cardSide(note), 'front')
  assert.equal(cardFace(note).text, 'Front text')
  assert.deepEqual(cardFace(note, 'back'), { title: '', text: '' })
})
