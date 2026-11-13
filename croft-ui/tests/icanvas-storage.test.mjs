import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'
import { cloneProjectTree } from '../src/features/icanvas/storage.ts'

test('Save As remaps nested canvases, object groups, edges and presentation stops', () => {
  const root = createProject('Trip')
  const child = createProject('Hotels', root.id)
  const grandchild = createProject('Paris Hotels', child.id)
  const external = createProject('Other project')
  const group = makeObject('group', { x: 0, y: 0 })
  const image = makeObject('image', { x: 10, y: 10 }, { parentId: group.id, assetId: 'photo-blob' })
  const childLink = makeObject('canvas', { x: 60, y: 10 }, { targetId: child.id })
  const externalLink = makeObject('canvas', { x: 80, y: 10 }, { targetId: external.id })
  const pageLink = makeObject('page', { x: 100, y: 10 }, { targetId: 'handbook' })
  const heading = makeObject('text', { x: 4, y: 7 }, { text: 'Options' })
  const grandchildLink = makeObject('canvas', { x: 300, y: 7 }, { targetId: grandchild.id })
  root.objects = [group, image, childLink, externalLink, pageLink]
  child.objects = [heading, grandchildLink]
  child.edges = [{ id: 'segment', kind: 'direction', from: heading.id, to: grandchildLink.id, label: '' }]
  root.coverAssetId = 'cover-blob'
  root.edges = [
    { id: 'edge-internal', kind: 'relationship', from: childLink.id, to: child.id, label: 'See also' },
    { id: 'edge-external', kind: 'relationship', from: childLink.id, to: external.id, label: 'See also' },
  ]
  root.stops = [{ id: 'stop-1', name: 'Hotel stop', canvasId: child.id, duration: 1200, camera: { x: 0, y: 10, zoom: 1 } }]

  const input = [root, external, grandchild, child]
  const [copy, childCopy, grandchildCopy] = cloneProjectTree(input, root.id, 'Trip backup')
  assert.equal(copy.name, 'Trip backup')
  assert.equal(copy.parentId, null)
  assert.equal(childCopy.parentId, copy.id)
  assert.equal(grandchildCopy.parentId, childCopy.id)
  assert.notEqual(copy.id, root.id)
  assert.notEqual(childCopy.id, child.id)
  assert.notEqual(grandchildCopy.id, grandchild.id)
  assert.notEqual(copy.objects[1].id, image.id)
  assert.equal(copy.objects[1].parentId, copy.objects[0].id)
  assert.equal(copy.objects[1].assetId, 'photo-blob')
  assert.equal(copy.coverAssetId, 'cover-blob')
  assert.equal(copy.objects[2].targetId, childCopy.id)
  assert.equal(childCopy.objects[1].targetId, grandchildCopy.id)
  assert.equal(copy.objects[3].targetId, undefined)
  assert.equal(copy.objects[4].targetId, 'handbook')
  assert.notEqual(copy.edges[0].id, root.edges[0].id)
  assert.equal(copy.edges.length, 1)
  assert.equal(copy.edges[0].from, copy.objects[2].id)
  assert.equal(copy.edges[0].to, childCopy.id)
  assert.equal(childCopy.edges[0].from, childCopy.objects[0].id)
  assert.equal(childCopy.edges[0].to, childCopy.objects[1].id)
  assert.notEqual(copy.stops[0].id, root.stops[0].id)
  assert.equal(copy.stops[0].canvasId, childCopy.id)
  assert.equal(cloneProjectTree(input, root.id, 'Copy with links', { preserveExternalCanvasLinks: true })[0].objects[3].targetId, external.id)
  childCopy.objects[0].text = 'Edited the copy'
  assert.equal(child.objects[0].text, 'Options')
})

test('Save As rejects cycles and empty names', () => {
  const root = createProject('Trip')
  const child = createProject('Hotels', root.id)
  assert.throws(() => cloneProjectTree([root, child], root.id, '    '), /name/)
  root.parentId = child.id
  assert.throws(() => cloneProjectTree([root, child], root.id, 'Trip copy'), /cycle/)
})
