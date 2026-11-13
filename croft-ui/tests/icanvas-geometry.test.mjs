import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_ZOOM, MIN_ZOOM, connectionEndpoints, fitViewport, intersects, placePoint, rectCenter,
  rotatedBounds, screenToWorld, snapPoint, visibleInViewport, worldToScreen, zoomAt,
} from '../src/features/icanvas/geometry.ts'

const closeTo = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-9,
  `Expected ${actual} to be close to ${expected}`,
)

test('camera transforms are inverse for translated, zoomed and negative coordinates', () => {
  const camera = { x: 37, y: -111, zoom: 0.7 }
  const world = { x: -204.25, y: 318.41 }
  const restored = screenToWorld(worldToScreen(world, camera), camera)
  closeTo(restored.x, world.x)
  closeTo(restored.y, world.y)
})

test('zoom clamps to 5–800% and preserves the world point under the cursor', () => {
  const camera = { x: 37, y: -111, zoom: 0.7 }
  const cursor = { x: 315, y: 251 }
  const anchor = screenToWorld(cursor, camera)

  for (const [requested, expected] of [[0, MIN_ZOOM], [2, 2], [100, MAX_ZOOM]]) {
    const zoomed = zoomAt(camera, cursor, requested)
    assert.equal(zoomed.zoom, expected)
    const restored = screenToWorld(cursor, zoomed)
    closeTo(restored.x, anchor.x)
    closeTo(restored.y, anchor.y)
  }
  assert.equal(zoomAt(camera, cursor, 1, { min: 2 }).zoom, 2)
  assert.equal(zoomAt(camera, cursor, camera.zoom), camera)
})

test('rotation expands the bounds around the same center', () => {
  const item = { x: -10, y: 5, width: 20, height: 10 }
  assert.deepEqual(rotatedBounds(item), { left: -10, top: 5, right: 10, bottom: 15 })
  const quarterTurn = rotatedBounds(item, 90)
  closeTo(quarterTurn.left, -5)
  closeTo(quarterTurn.top, 0)
  closeTo(quarterTurn.right, 5)
  closeTo(quarterTurn.bottom, 20)
  closeTo(rotatedBounds(item, -45).right, 15 / Math.sqrt(2))
  assert.deepEqual(rectCenter(item), { x: 0, y: 10 })
})

test('fit includes the whole rotated selection plus the requested screen padding', () => {
  const items = [
    { x: -250, y: -300, width: 80, height: 280, rotation: 90 },
    { x: 100, y: 30, width: 70, height: 50, rotation: 45 },
  ]
  const size = { width: 800, height: 500 }
  const padding = 40
  const fitted = fitViewport(items, size, { padding })
  const bounds = items.map(item => rotatedBounds(item, item.rotation))
  const left = Math.min(...bounds.map(item => item.left))
  const top = Math.min(...bounds.map(item => item.top))
  const right = Math.max(...bounds.map(item => item.right))
  const bottom = Math.max(...bounds.map(item => item.bottom))
  const first = worldToScreen({ x: left, y: top }, fitted)
  const last = worldToScreen({ x: right, y: bottom }, fitted)

  assert.ok(first.x >= padding - 1e-9 && first.y >= padding - 1e-9)
  assert.ok(last.x <= size.width - padding + 1e-9 && last.y <= size.height - padding + 1e-9)
  closeTo(first.x + last.x, size.width)
  closeTo(first.y + last.y, size.height)
  closeTo(Math.min(first.x, first.y), padding)
})

test('fit has finite empty and constrained viewport results', () => {
  assert.deepEqual(fitViewport([], { width: 800, height: 400 }), { x: 400, y: 200, zoom: 1 })
  const point = { x: 9, y: -10, width: 0, height: 0 }
  const small = { width: 12, height: 14 }
  const fitted = fitViewport([point], small, { padding: 40, max: 0.5 })
  assert.equal(fitted.zoom, 0.5)
  assert.deepEqual(worldToScreen(point, fitted), { x: 6, y: 7 })
})

test('intersection includes crossing and touching rectangles', () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 }
  assert.equal(intersects(rect, { x: 5, y: -10, width: 2, height: 30 }), true)
  assert.equal(intersects(rect, { x: 10, y: 10, width: 2, height: 2 }), true)
  assert.equal(intersects(rect, { x: 11, y: 0, width: 2, height: 2 }), false)
})

test('viewport culling accounts for zoom, rotation and screen-pixel overscan', () => {
  const camera = { x: 0, y: 0, zoom: 2 }
  const size = { width: 200, height: 100 }
  const offscreen = { x: 105, y: 2, width: 10, height: 30 }
  assert.equal(visibleInViewport(offscreen, camera, size), false)
  assert.equal(visibleInViewport(offscreen, camera, size, 90), true)
  assert.equal(visibleInViewport(offscreen, camera, size, 0, 9), false)
  assert.equal(visibleInViewport(offscreen, camera, size, 0, 10), true)
})

test('Smart placement snaps symmetrically while Free placement preserves coordinates', () => {
  const point = { x: -36, y: 12 }
  assert.deepEqual(placePoint(point, 'smart'), { x: -48, y: 24 })
  assert.equal(placePoint(point, 'free'), point)
  assert.deepEqual(snapPoint({ x: 13, y: -5 }, 10), { x: 10, y: -10 })
  assert.equal(snapPoint(point, 0), point)
})

test('connection endpoints follow the center of each current rectangle', () => {
  assert.deepEqual(
    connectionEndpoints(
      { x: -4, y: 10, width: 20, height: 60 },
      { x: 109, y: 24, width: 2, height: 50 },
    ),
    { from: { x: 6, y: 40 }, to: { x: 110, y: 49 } },
  )
})
