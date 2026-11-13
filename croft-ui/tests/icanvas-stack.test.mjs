import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeObject } from '../src/features/icanvas/model.ts'
import { connectionEndpoints, rectCenter, rotatedBounds, transformDescendant } from '../src/features/icanvas/geometry.ts'
import { createHistory, recordHistory, redoHistory, undoHistory } from '../src/features/icanvas/history.ts'
import {
  addToStack, canAddToStack, canStackCards, createStack, extractFromStack, layoutStacks,
  moveStack, setStackLayout, showStackMember, unstackAll,
} from '../src/features/icanvas/stackScene.ts'

const fixture = () => {
  const frame = makeObject('frame', { x: 0, y: 0 }, { width: 900, height: 630 })
  const cards = [
    makeObject('note', { x: 10, y: 25 }, { name: 'Trip note', parentId: frame.id, width: 130 }),
    makeObject('file', { x: 220, y: 25 }, { name: 'Tickets', parentId: frame.id, assetId: 'tickets', width: 165 }),
    makeObject('note', { x: 430, y: 25 }, { name: 'Map', parentId: frame.id, visibleSide: 'back',
      back: { title: 'Meeting point', text: 'Side entrance', assetId: 'map-back' }, rotation: 25, width: 245, height: 90 }),
    makeObject('image', { x: 640, y: 25 }, { name: 'Hotel', mode: 'card', parentId: frame.id, assetId: 'hotel',
      width: 195, height: 155, rotation: -8 }),
  ]
  const independent = makeObject('rectangle', { x: 100, y: 105 }, { parentId: frame.id })
  return { frame, cards, independent, objects: [frame, ...cards, independent] }
}

const byId = (objects, id) => objects.find(object => object.id === id)
const point = object => ({ x: object.x, y: object.y })
const closeTo = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `Expected ${a} to be close to ${b}`)

test('creates a compact ordered stack without changing the selected cards’ content or canonical geometry', () => {
  const { frame, cards, independent, objects } = fixture()
  assert.equal(canStackCards(objects, cards.map(card => card.id)), true)
  const { objects: stacked, stackId } = createStack(objects, cards.map(card => card.id), ' Travel notes  ')
  const stack = byId(stacked, stackId)
  assert.equal(stack.name, 'Travel notes')
  assert.equal(stack.parentId, frame.id)
  assert.deepEqual(stack.stack, { order: cards.map(card => card.id).reverse(), layout: 'compact' })
  assert.equal(byId(stacked, independent.id), independent)
  cards.forEach(card => assert.deepEqual(byId(stacked, card.id), { ...card, parentId: stackId }))

  const layout = layoutStacks(stacked)
  assert.deepEqual([...layout.cards.keys()], [cards[3].id])
  assert.deepEqual([...layout.obscured], [cards[2].id, cards[1].id, cards[0].id])
  assert.deepEqual(layout.piles.get(stackId).rear.map(card => card.memberId), [cards[2].id, cards[1].id, cards[0].id])
  const initialCenter = rectCenter(layout.cards.get(cards[3].id))
  const newScene = showStackMember(stacked, stackId, cards[2].id)
  const rendered = layoutStacks(newScene).cards.get(cards[2].id)
  assert.deepEqual(rectCenter(rendered), initialCenter)
  assert.equal(rendered.rotation, cards[2].rotation)
  assert.deepEqual(rendered.back, cards[2].back)
  assert.equal(rendered.visibleSide, 'back')
  assert.equal(rendered.width, cards[2].width)
  assert.equal(rendered.height, cards[2].height)
  assert.equal(byId(newScene, cards[2].id), byId(stacked, cards[2].id))
})

test('fan and compact projections retain true edge identities and ignore hidden branches', () => {
  const { frame, cards, objects } = fixture()
  const { objects: stacked, stackId } = createStack(objects, cards.map(card => card.id))
  const compact = layoutStacks(stacked)
  const before = layoutStacks(setStackLayout(stacked, stackId, 'fan'))
  const hiddenId = cards[1].id
  const frontId = cards[3].id
  assert.equal(before.cards.size, 4)
  assert.equal(before.obscured.size, 0)
  const bounds = [...before.cards.values()].map(card => rotatedBounds(card, card.rotation))
  // In its own rotated local coordinate system each fan slot has independent room.
  assert.equal(new Set([...before.cards.values()].map(card => JSON.stringify(point(card)))).size, 4)
  assert.ok(bounds.every(item => item.bottom > item.top && item.right > item.left))
  const edge = { from: cards[0].id, to: cards[1].id }
  assert.notDeepEqual(connectionEndpoints(compact.proxies.get(edge.from), compact.proxies.get(edge.to)),
    connectionEndpoints(before.proxies.get(edge.from), before.proxies.get(edge.to)))
  assert.deepEqual(compact.piles.get(stackId).order, before.piles.get(stackId).order)
  assert.deepEqual(rectCenter(compact.cards.get(frontId)), rectCenter(before.cards.get(frontId)))
  assert.deepEqual(layoutStacks(setStackLayout(setStackLayout(stacked, stackId, 'fan'), stackId, 'compact')), compact)

  const hidden = stacked.map(object => object.id === hiddenId ? { ...object, hidden: true } : object)
  const hiddenScene = layoutStacks(hidden)
  assert.equal(hiddenScene.obscured.has(hiddenId), true)
  assert.equal(hiddenScene.proxies.has(hiddenId), false, 'Explicitly hidden member edges must not acquire a proxy.')
  assert.throws(() => showStackMember(hidden, stackId, hiddenId, { preview: true }), /Layers/)
  const collapsed = hidden.map(object => object.id === frame.id ? { ...object, collapsed: true } : object)
  assert.equal(layoutStacks(collapsed).cards.size, 0)
  assert.equal(layoutStacks(collapsed).proxies.size, 0)
  assert.deepEqual(layoutStacks(collapsed).piles.get(stackId).order, compact.piles.get(stackId).order)
})

test('locks and shared ownership prevent unexpected captures and nested stacks', () => {
  const { cards, frame, independent, objects } = fixture()
  const rootCard = makeObject('note', { x: 3000, y: 0 })
  const looseMedia = makeObject('image', { x: 90, y: 0 }, { parentId: frame.id })
  assert.equal(canStackCards([...objects, rootCard], [rootCard.id, cards[0].id]), false)
  assert.equal(canStackCards(objects, [cards[0].id, independent.id]), false)
  assert.equal(canStackCards([...objects, looseMedia], [looseMedia.id, cards[0].id]), false)
  assert.equal(canStackCards(objects, [cards[0].id, cards[0].id]), false)
  const { objects: stacked, stackId } = createStack(objects, [cards[0].id, cards[1].id])
  assert.equal(canStackCards(stacked, [cards[2].id, stackId]), false)
  assert.equal(canAddToStack(stacked, stackId, [cards[0].id]), false)
  assert.equal(canAddToStack([...stacked, rootCard], stackId, [rootCard.id]), false)
  assert.equal(canAddToStack(stacked, stackId, [cards[2].id, cards[3].id]), true)
  const locked = stacked.map(item => item.id === frame.id ? { ...item, locked: true } : item)
  assert.equal(canAddToStack(locked, stackId, [cards[2].id]), false)
  assert.throws(() => unstackAll(locked, stackId), /unlock/)
  assert.throws(() => moveStack(locked, stackId, { x: 0, y: 0 }), /unlock/)
  assert.throws(() => setStackLayout(locked, stackId, 'fan'), /unlock/)
  assert.equal(layoutStacks(setStackLayout(locked, stackId, 'fan', { preview: true })).cards.size, 2)
  assert.equal(layoutStacks(showStackMember(locked, stackId, cards[0].id, { preview: true })).piles.get(stackId).frontId, cards[0].id)
})

test('move, explicit add, extraction and unstack preserve payloads and independent IDs', () => {
  const { cards, frame, objects } = fixture()
  const { objects: stacked, stackId } = createStack(objects, [cards[0].id, cards[1].id, cards[2].id])
  const start = byId(stacked, stackId)
  const moved = moveStack(stacked, stackId, { x: start.x + 205, y: start.y + 118 })
  for (const member of cards.slice(0, 3)) {
    const after = byId(moved, member.id)
    closeTo(after.x, member.x + 205)
    closeTo(after.y, member.y + 118)
    assert.equal(after.rotation, member.rotation)
  }
  assert.equal(byId(moved, cards[3].id), cards[3])
  const added = addToStack(moved, stackId, [cards[3].id])
  assert.equal(byId(added, stackId).stack.order[0], cards[3].id)
  assert.deepEqual(byId(added, cards[3].id), { ...cards[3], parentId: stackId })
  const extracted = extractFromStack(added, stackId, cards[2].id, { x: 1100, y: 900, name: 'Transient preview', mode: 'direct' })
  assert.deepEqual(byId(extracted, cards[2].id), { ...cards[2], x: 1100, y: 900, parentId: frame.id })
  assert.equal(byId(extracted, stackId).stack.order.length, 3)
  const released = unstackAll(extracted, stackId)
  assert.equal(released.length, objects.length)
  assert.equal(new Set(released.map(item => item.id)).size, objects.length)
  assert.equal(byId(released, stackId), undefined)
  for (const member of cards) {
    const restored = byId(released, member.id)
    assert.equal(restored.parentId, frame.id)
    assert.equal(restored.assetId, member.assetId)
    assert.equal(restored.back, member.back)
    assert.equal(restored.visibleSide, member.visibleSide)
    assert.equal(restored.width, member.width)
    assert.equal(restored.height, member.height)
  }
  // These stored positions did not overlap before the move and retain their offsets.
  closeTo(byId(released, cards[0].id).x, cards[0].x + 205)
  closeTo(byId(released, cards[1].id).x, cards[1].x + 205)
})

test('one-card stack is valid and last extraction removes only the empty stack', () => {
  const { cards, objects } = fixture()
  const { objects: stacked, stackId } = createStack(objects, cards.slice(0, 2).map(card => card.id))
  const single = extractFromStack(stacked, stackId, cards[1].id)
  assert.deepEqual(byId(single, stackId).stack.order, [cards[0].id])
  assert.equal(layoutStacks(single).cards.size, 1)
  const empty = extractFromStack(single, stackId, cards[0].id)
  assert.equal(byId(empty, stackId), undefined)
  assert.deepEqual(new Set(empty.map(object => object.id)), new Set(objects.map(object => object.id)))
})

test('large compact stack mounts one card and at most three rear outlines', () => {
  const source = Array.from({ length: 1200 }, () => makeObject('note', { x: 100, y: 100 }))
  const { objects, stackId } = createStack(source, source.map(card => card.id))
  const scene = layoutStacks(objects)
  assert.equal(scene.cards.size, 1)
  assert.equal(scene.obscured.size, 1199)
  assert.equal(scene.piles.get(stackId).rear.length, 3)
  assert.equal(scene.proxies.size, 1200)
})

test('container transforms each descendant once and a stack command can undo atomically', () => {
  const { frame, cards, independent, objects } = fixture()
  const { objects: stacked, stackId } = createStack(objects, cards.map(card => card.id))
  const movedFrame = { ...frame, x: frame.x + 120, y: frame.y - 80, width: frame.width * 2, height: frame.height * 2, rotation: 80 }
  const transformed = stacked.map(item => item.id === frame.id ? movedFrame : transformDescendant(item, frame, movedFrame, 2))
  const scene = layoutStacks(transformed)
  const front = scene.cards.get(cards[3].id)
  assert.equal(front.rotation, (cards[3].rotation + 80) % 360)
  assert.equal(front.width, cards[3].width * 2)
  assert.deepEqual(rectCenter(front), rectCenter(byId(transformed, stackId)))
  assert.equal(byId(transformed, cards[2].id).back, cards[2].back)

  const additions = new Map(stacked.map(item => [item.id, item]))
  const changes = [
    ...objects.filter(item => item !== additions.get(item.id)).map(item => ({ id: item.id, before: item, after: additions.get(item.id) })),
    { id: stackId, before: null, after: additions.get(stackId) },
  ]
  const history = recordHistory(createHistory(), changes)
  const undo = undoHistory(history)
  assert.equal(undo.changes.length, 5)
  assert.equal(undo.changes.some(change => change.id === independent.id), false)
  const restored = new Map(additions)
  for (const entry of undo.changes) {
    if (entry.after === null) restored.delete(entry.id)
    else restored.set(entry.id, entry.after)
  }
  assert.deepEqual([...restored.values()], objects)
  assert.deepEqual(redoHistory(undo.history).changes, changes)
})
