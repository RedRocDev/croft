import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'
import { cloneWorkspaceBackup, inspectWorkspaceBackup, parseWorkspaceBackup, streamWorkspaceBackup } from '../src/features/icanvas/workspaceBackup.ts'
import { makeProjectPackage, projectExportInventory } from '../src/features/icanvas/portability.ts'

const MiB = 1024 ** 2

function fixture(size = 43 * MiB) {
  const root = createProject('Expedition')
  const child = createProject('Camps', root.id)
  const trashed = { ...createProject('Former plans'), trashedAt: Date.now() }
  const attachment = { id: 'source', name: 'maps.bin', mime: 'application/octet-stream', size, blob: new Blob([new Uint8Array(size).fill(65)]) }
  const icon = { id: 'avatar', name: 'icon.txt', mime: 'text/plain', size: 3, blob: new Blob(['abc']) }
  const link = { id: 'link', name: 'live.txt', mime: 'text/plain', size: 5, linked: true }
  const old = { id: 'old', name: 'previous.txt', mime: 'text/plain', size: 6, blob: new Blob(['before']) }
  root.objects = [
    makeObject('file', { x: 0, y: 0 }, { assetId: attachment.id }),
    makeObject('canvas', { x: 35, y: 0 }, { targetId: child.id }),
    makeObject('page', { x: 62, y: 0 }, { targetId: 'croft-home' }),
  ]
  root.iconAssetId = icon.id
  root.edges = [{ id: 'outbound', kind: 'connection', from: root.objects[0].id, to: root.objects[1].id, label: 'Journey' }]
  root.camera = { x: -64e12 - 256, y: 65e12 + 256, zoom: 64 }
  root.stops = [{ id: 'scene', canvasId: child.id, name: 'Camps', camera: child.camera, duration: 5 }]
  child.objects = [makeObject('file', { x: 2, y: 1 }, { assetId: link.id })]
  const before = structuredClone(root)
  before.objects[0].assetId = old.id
  const versions = [{ id: 'stored-version', projectId: root.id, project: before, number: 1, notes: 'Checkpoint', descendants: [structuredClone(child)], createdAt: Date.now() }]
  const recoveries = [{ id: 'stored-recovery', projectId: root.id, project: structuredClone(before), createdAt: Date.now() }]
  return { projects: [root, child, trashed], assets: [attachment, icon, link, old], versions, recoveries }
}

async function encode(state) {
  const chunks = []
  await streamWorkspaceBackup(state, { async write(bytes) { chunks.push(bytes.slice()) } })
  return { file: new Blob(chunks), chunks }
}

test('workspace backup round-trips fairly large media, hierarchy, edges, Trash, icon, linked metadata and snapshots', async () => {
  const state = fixture()
  const inventory = inspectWorkspaceBackup(state)
  assert.equal(inventory.projects, 3)
  assert.equal(inventory.trashed, 1)
  assert.equal(inventory.versions, 1)
  assert.equal(inventory.recoveries, 1)
  assert.equal(inventory.links.length, 1)
  assert.equal(inventory.externalPages, 3)
  assert.equal(inventory.bytes, 43 * MiB + 9)
  const portable = projectExportInventory(state.projects, state.projects[0], { scope: 'project' }, state.assets)
  assert.deepEqual(portable.overLimit.map(row => row.name), ['maps.bin'])
  await assert.rejects(makeProjectPackage(state.projects, state.projects[0].id, { scope: 'project' }, state.assets), /editable package limit/)

  const { file, chunks } = await encode(state)
  assert.ok(Math.max(...chunks.map(chunk => chunk.byteLength)) <= MiB)
  const restored = cloneWorkspaceBackup(await parseWorkspaceBackup(file))
  const [root, child, trash] = restored.projects
  assert.notEqual(root.id, state.projects[0].id)
  assert.equal(child.parentId, root.id)
  assert.equal(root.objects[1].targetId, child.id)
  assert.equal(trash.trashedAt, state.projects[2].trashedAt)
  assert.equal(root.edges[0].from, root.objects[0].id)
  assert.equal(root.edges[0].to, root.objects[1].id)
  assert.equal(root.stops[0].canvasId, child.id)
  assert.deepEqual(root.camera, state.projects[0].camera)
  assert.equal(await restored.assets.find(asset => asset.id === root.iconAssetId).blob.text(), 'abc')
  assert.equal(restored.assets.find(asset => asset.id === child.objects[0].assetId).linked, true)
  const body = restored.assets.find(asset => asset.id === root.objects[0].assetId).blob
  assert.equal(body.size, 43 * MiB)
  assert.equal(await body.slice(-10).text(), 'A'.repeat(10))
  const version = restored.versions[0]
  assert.equal(version.projectId, root.id)
  assert.equal(version.project.id, root.id)
  assert.deepEqual(version.project.camera, root.camera)
  assert.equal(version.project.objects[0].id, root.objects[0].id)
  assert.equal(version.project.edges[0].id, root.edges[0].id)
  assert.equal(version.descendants[0].parentId, root.id)
  assert.equal(await restored.assets.find(asset => asset.id === version.project.objects[0].assetId).blob.text(), 'before')
  assert.equal(restored.recoveries[0].project.objects[0].assetId, version.project.objects[0].assetId)
})

test('workspace backup rejects truncation, extra bytes, corruption and aborts a write without finishing', async () => {
  const state = fixture(2 * MiB)
  const { file, chunks } = await encode(state)
  await assert.rejects(parseWorkspaceBackup(file.slice(0, file.size - 1)), /byte count|incomplete/)
  await assert.rejects(parseWorkspaceBackup(new Blob([file, 'extra'])), /byte count/)
  const corrupted = [...chunks]
  corrupted[5] = corrupted[5].slice()
  corrupted[5][0] ^= 1
  await assert.rejects(parseWorkspaceBackup(new Blob(corrupted)), /checksum/)
  const controller = new AbortController()
  let writes = 0
  await assert.rejects(streamWorkspaceBackup(state, { async write() { if (++writes === 5) controller.abort() } }, { signal: controller.signal }), { name: 'AbortError' })
  assert.ok(writes < chunks.length)
})

test('legacy references with absent asset rows are inventoried and become restorable placeholders', async () => {
  const state = fixture(1024)
  state.assets.splice(0, 1)
  const { absent } = inspectWorkspaceBackup(state)
  assert.deepEqual(absent.map(asset => asset.id), ['source'])
  const { file } = await encode(state)
  const restored = cloneWorkspaceBackup(await parseWorkspaceBackup(file))
  const missing = restored.assets.find(asset => asset.id === restored.projects[0].objects[0].assetId)
  assert.equal(missing.name, 'Unavailable file (source)')
  assert.equal(missing.blob, undefined)
})
