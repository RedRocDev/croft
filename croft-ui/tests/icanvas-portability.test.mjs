import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { createProject, makeObject, seedProjects } from '../src/features/icanvas/model.ts'
import { importProject, makeProjectPackage, renderProjectSvg } from '../src/features/icanvas/portability.ts'

const decode = new TextDecoder()
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/s4sAAAAASUVORK5CYII=', 'base64')

test('editable package preserves nested canvases, media, edges, and presentation targets with new IDs', async () => {
  const originals = seedProjects()
  const root = originals[0]
  root.camera = { x: -64e12 - 128, y: 64e12 + 128, zoom: 64 }
  const sourceFrame = root.objects.find(item => item.kind === 'frame')
  sourceFrame.frameBase = { x: -20, y: 315, width: 520, height: 220, rotation: 0 }
  sourceFrame.width = 960
  const mediaId = crypto.randomUUID()
  const linkedId = crypto.randomUUID()
  root.coverAssetId = mediaId
  root.objects.push(makeObject('image', { x: -46, y: 210 }, { assetId: mediaId }))
  root.objects.push(makeObject('file', { x: 150, y: 210 }, { assetId: linkedId }))
  root.stops.push({ id: crypto.randomUUID(), name: 'First stop', canvasId: originals[1].id, camera: { x: 4, y: 8, zoom: 0.6 }, duration: 2 })
  const originalAssets = [
    { id: mediaId, name: 'pixel.png', mime: 'image/png', size: imageBytes.length, blob: new Blob([imageBytes], { type: 'image/png' }) },
    { id: linkedId, name: 'linked.txt', mime: 'text/plain', size: 320, handle: { kind: 'file' } },
  ]
  const packageFile = await makeProjectPackage(originals, root.id, { scope: 'project' }, originalAssets)
  const { projects, assets } = await importProject(packageFile)
  assert.equal(projects.length, 3)
  const [copy, child, grandchild] = projects
  assert.notEqual(copy.id, root.id)
  assert.equal(copy.parentId, null)
  assert.deepEqual(copy.camera, root.camera)
  assert.equal(child.parentId, copy.id)
  assert.equal(grandchild.parentId, child.id)
  assert.equal(copy.objects.find((item) => item.kind === 'canvas').targetId, child.id)
  assert.equal(copy.stops[0].canvasId, child.id)
  assert.deepEqual(copy.stops[0].camera, root.stops[0].camera)
  const note = copy.objects.find((item) => item.name === 'The plan')
  assert.notEqual(note.id, root.edges[0].from)
  assert.equal(copy.edges[0].from, note.id)
  const frame = copy.objects.find((item) => item.kind === 'frame')
  assert.equal(copy.objects.find((item) => item.name === 'Getting there').parentId, frame.id)
  assert.deepEqual(frame.frameBase, sourceFrame.frameBase)
  const importedImage = assets.find((asset) => asset.name === 'pixel.png')
  assert.notEqual(importedImage.id, mediaId)
  assert.equal(copy.coverAssetId, importedImage.id)
  const image = copy.objects.find((item) => item.kind === 'image')
  assert.equal(image.assetId, importedImage.id)
  assert.equal(image.x, -46)
  assert.deepEqual(Buffer.from(await importedImage.blob.arrayBuffer()), imageBytes)
  assert.deepEqual(assets.find((asset) => asset.name === 'linked.txt'), { id: copy.objects.find((item) => item.kind === 'file').assetId, name: 'linked.txt', mime: 'text/plain', size: 320, linked: true })
})

test('current canvas and selected object packages omit content outside their scope', async () => {
  const originals = seedProjects()
  const root = originals[0]
  const child = originals[1]
  const fromChild = await importProject(await makeProjectPackage(originals, child.id))
  assert.equal(fromChild.projects.length, 1)
  assert.equal(fromChild.projects[0].parentId, null)
  assert.equal(fromChild.projects[0].objects.find((item) => item.kind === 'canvas').targetId, undefined)
  const frame = root.objects.find((item) => item.kind === 'frame')
  const { projects } = await importProject(await makeProjectPackage(originals, root.id, { scope: 'selection', selectedIds: [frame.id] }))
  assert.deepEqual(projects[0].objects.map((item) => item.name), ['Travel notes', 'Getting there', 'Studio handbook'])
  assert.equal(projects[0].edges.length, 0)
})

test('rejects unsupported packages and fails when asset contents differ from their checksum', async () => {
  await assert.rejects(importProject(new Blob(['{"format":"croft-icanvas","version":99}'])), /unsupported/i)
  const project = createProject('Package with image')
  const asset = { id: crypto.randomUUID(), name: 'pixel.png', mime: 'image/png', size: imageBytes.length, blob: new Blob([imageBytes]) }
  project.objects.push(makeObject('image', { x: 0, y: 0 }, { assetId: asset.id }))
  const file = await makeProjectPackage([project], project.id, {}, [asset])
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifest = JSON.parse(decode.decode(entries['manifest.json']))
  await assert.rejects(importProject(new Blob([zipSync(entries, { level: 6 })])), /stored zip entries/i)
  const unrelated = { ...entries, 'unrelated.txt': strToU8('not part of the package') }
  await assert.rejects(importProject(new Blob([zipSync(unrelated, { level: 0 })])), /unexpected path/i)
  const assetPath = manifest.assets[0].path
  entries[assetPath] = entries[assetPath].slice()
  entries[assetPath][entries[assetPath].length - 1] ^= 1
  await assert.rejects(importProject(new Blob([zipSync(entries, { level: 0 })])), /checksum/i)
})

test('renders escaped SVG text, bounded image dimensions and visible model content', async () => {
  const project = createProject('Studio & archive')
  project.objects.push(makeObject('note', { x: -400, y: 30 }, { text: 'Coast <garden> & trail', width: 260 }))
  project.objects.push(makeObject('note', { x: 400_000, y: 20 }, { text: 'Distant note' }))
  project.objects.push(makeObject('note', { x: 0, y: 0 }, { text: 'Hidden note', hidden: true }))
  const picture = await renderProjectSvg(project, { background: 'grid' })
  const svg = await picture.blob.text()
  assert.ok(picture.width <= 4096)
  assert.ok(picture.height > 0)
  assert.match(svg, /Studio &amp; archive/)
  assert.match(svg, /Coast &lt;garden&gt; &amp; trail/)
  assert.match(svg, /Distant note/)
  assert.match(svg, /fill="url\(#grid\)"/)
  assert.doesNotMatch(svg, /Hidden note/)
})
