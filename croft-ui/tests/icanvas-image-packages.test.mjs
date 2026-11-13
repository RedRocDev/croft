import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { defaultImageEdits } from '../src/features/icanvas/imageEdits.ts'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'
import { importProject, makeProjectPackage, renderProjectSvg } from '../src/features/icanvas/portability.ts'
import { cloneProjectTree } from '../src/features/icanvas/storage.ts'
import { cloneWorkspaceBackup, parseWorkspaceBackup, streamWorkspaceBackup } from '../src/features/icanvas/workspaceBackup.ts'

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/s4sAAAAASUVORK5CYII=', 'base64')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const decode = new TextDecoder()

function fixture() {
  const project = createProject('Edited card project')
  const id = 'shared-original'
  const frontEdits = { ...structuredClone(defaultImageEdits), source: { width: 1, height: 1 }, crop: { x: 0.2, y: 0.1, width: 0.55, height: 0.8 } }
  frontEdits.tone.warmth = 34
  const backEdits = { ...structuredClone(defaultImageEdits), source: { width: 1, height: 1 } }
  backEdits.mask.shape = 'circle'
  backEdits.shadow = { ...backEdits.shadow, enabled: true, x: 31, y: -17, opacity: 51 }
  const card = makeObject('image', { x: 10, y: 22 }, { name: 'Picture', mode: 'card', assetId: id, imageEdits: frontEdits,
    back: { title: 'Reverse', text: '', assetId: id, imageEdits: backEdits } })
  const shared = makeObject('image', { x: 50, y: 60 }, { name: 'Same source', assetId: id })
  const note = makeObject('text', { x: 20, y: 10 }, { text: 'Editable swatch text', textColour: '#4c66b0' })
  project.objects = [card, shared, note]
  project.swatches = [{ id: 'sampler', name: 'Sampled colour', colour: '#4c66b08c' }]
  project.edges = [{ id: 'colour-edge', kind: 'direction', from: shared.id, to: note.id, label: '', colour: '#4c66b0' }]
  const source = { id, name: 'known.png', mime: 'image/png', size: pixels.length, blob: new Blob([pixels], { type: 'image/png' }) }
  return { project, source, card, shared, frontEdits, backEdits }
}

test('v3 editable package keeps independent faces, swatches and one exact copy of the original source', async () => {
  const { project, source, card, frontEdits, backEdits } = fixture()
  const file = await makeProjectPackage([project], project.id, {}, [source])
  const zipped = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifest = JSON.parse(decode.decode(zipped['manifest.json']))
  assert.equal(manifest.version, 3)
  assert.equal(manifest.assets.length, 1)
  const { projects: [restored], assets } = await importProject(file)
  const [copy, sameSource, note] = restored.objects
  assert.notEqual(copy.id, card.id)
  assert.equal(copy.assetId, copy.back.assetId)
  assert.equal(sameSource.assetId, copy.assetId)
  assert.notEqual(copy.assetId, source.id)
  assert.equal(sameSource.imageEdits, undefined)
  assert.deepEqual(copy.imageEdits, frontEdits)
  assert.deepEqual(copy.back.imageEdits, backEdits)
  assert.deepEqual(restored.swatches, project.swatches)
  assert.equal(note.textColour, project.objects[2].textColour)
  assert.equal(restored.edges[0].colour, project.edges[0].colour)
  assert.equal(digest(new Uint8Array(await assets[0].blob.arrayBuffer())), digest(pixels))
  copy.imageEdits.tone.warmth = -5
  assert.equal(copy.back.imageEdits.tone.warmth, 0)
  assert.equal(frontEdits.tone.warmth, 34)
  await assert.rejects(importProject(new Blob([JSON.stringify({ ...manifest, version: 2 })])), /requires a version 3/)
  const invalid = structuredClone(manifest)
  invalid.projects[0].objects[0].imageEdits.version = 99
  await assert.rejects(importProject(new Blob([JSON.stringify(invalid)])), /Unsupported image edit version/)
  invalid.projects[0].objects[0].imageEdits.version = 1
  invalid.projects[0].objects[0].imageEdits.crop.x = .99
  await assert.rejects(importProject(new Blob([JSON.stringify(invalid)])), /outside the source/)
  invalid.projects[0].objects[0].imageEdits.crop.x = .2
  invalid.assets[0].mime = 'text/plain'
  await assert.rejects(importProject(new Blob([JSON.stringify(invalid)])), /requires? a supported raster image/)
})

test('workspace v3 retains image settings and exact originals through history and independent copies', async () => {
  const { project, source } = fixture()
  const before = structuredClone(project)
  before.objects[0].imageEdits.tone.contrast = 65
  before.swatches[0].name = 'Earlier sampled colour'
  const version = { id: 'version', projectId: project.id, project: before, createdAt: project.createdAt, number: 1, notes: '', descendants: [] }
  const recovery = { id: 'recovery', projectId: project.id, project: before, createdAt: project.createdAt }
  const chunks = []
  await streamWorkspaceBackup({ projects: [project], assets: [source], versions: [version], recoveries: [recovery] }, {
    async write(bytes) { chunks.push(bytes.slice()) },
  })
  assert.equal(decode.decode(chunks[0]), 'CROFT WORKSPACE BACKUP 3\n')
  const parsed = await parseWorkspaceBackup(new Blob(chunks))
  const restored = cloneWorkspaceBackup(parsed)
  assert.equal(restored.versions[0].project.objects[0].imageEdits.tone.contrast, 65)
  assert.equal(restored.recoveries[0].project.swatches[0].name, 'Earlier sampled colour')
  assert.deepEqual(restored.projects[0].objects[0].back.imageEdits, before.objects[0].back.imageEdits)
  assert.equal(digest(new Uint8Array(await restored.assets[0].blob.arrayBuffer())), digest(pixels))
  restored.projects[0].objects[0].back.imageEdits.shadow.x = 0
  restored.projects[0].swatches[0].name = 'New name'
  assert.equal(parsed.projects[0].objects[0].back.imageEdits.shadow.x, 31)
  assert.equal(restored.versions[0].project.objects[0].back.imageEdits.shadow.x, 31)
  assert.equal(parsed.projects[0].swatches[0].name, 'Sampled colour')
  const [savedAs] = cloneProjectTree([project], project.id, 'Copy')
  savedAs.objects[0].imageEdits.tone.warmth = -34
  assert.equal(savedAs.objects[1].assetId, source.id)
  assert.equal(project.objects[0].imageEdits.tone.warmth, 34)
  await assert.rejects(parseWorkspaceBackup(new Blob(['CROFT WORKSPACE BACKUP 2\n', ...chunks.slice(1)])), /requires a version 3/)
})

test('visual export fails clearly when an edited source is missing or permission is denied', async () => {
  const { project, source } = fixture()
  await assert.rejects(renderProjectSvg(project), /source for edited image “Picture” is missing/)
  const unavailable = { ...source, blob: undefined, handle: { async queryPermission() { return 'denied' }, async getFile() { assert.fail('Must not read a denied link') } } }
  await assert.rejects(renderProjectSvg(project, {}, [unavailable]), /Restore file access or relink/)
  const { blob } = await renderProjectSvg({ ...project, objects: project.objects.slice(-2), edges: project.edges }, {}, [source])
  const svg = await blob.text()
  assert.match(svg, /fill="#4c66b0"/)
  assert.match(svg, /stroke="#4c66b0"[^>]+marker-end="url\(#arrow\)"/)
})
