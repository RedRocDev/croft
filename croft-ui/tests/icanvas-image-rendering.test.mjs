import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultImageEdits, imageEffectInsets, imageFrameSize, readImageEdits } from '../src/features/icanvas/imageEdits.ts'
import { applyImageColour } from '../src/features/icanvas/imageRendering.ts'

test('image edit validation rejects unknown schemas, malformed components, and out of range crop areas', () => {
  assert.deepEqual(readImageEdits(defaultImageEdits), defaultImageEdits)
  for (const change of [
    { version: 2 }, { mystery: true }, { source: { width: 501, height: Infinity } },
    { source: { width: 501.5, height: 290 } }, { crop: { x: .15, y: .11, width: .9, height: .6 } },
    { crop: { x: 0, y: 0, width: .009, height: 1 } }, { mask: { ...defaultImageEdits.mask, shape: 'polygon' } },
    { shadow: { ...defaultImageEdits.shadow, x: -101 } }, { outline: { ...defaultImageEdits.outline, colour: '#fff' } },
    { tone: { ...defaultImageEdits.tone, warmth: NaN } },
  ]) assert.throws(() => readImageEdits({ ...defaultImageEdits, ...change }), /image/i)
})

test('light and colour adjustments preserve alpha and Looks compose with manual values', () => {
  const adjust = (tone = {}, name = 'original', intensity = 100) => {
    const pixels = Uint8ClampedArray.of(120, 120, 120, 127, 160, 110, 75, 255, 5, 8, 3, 0)
    applyImageColour(pixels, { ...defaultImageEdits.tone, ...tone }, { name, intensity })
    assert.deepEqual([...pixels.slice(8)], [5, 8, 3, 0])
    assert.equal(pixels[3], 127)
    assert.equal(pixels[7], 255)
    return [...pixels.slice(0, 8)]
  }
  const original = adjust()
  assert.deepEqual(original.slice(0, 3), [120, 120, 120])
  assert.ok(adjust({ brightness: 20 })[0] > original[0])
  assert.ok(adjust({ contrast: 20 })[4] > original[4])
  assert.ok(adjust({ contrast: 20 })[6] < original[6])
  const [, , , , r, g, b] = adjust({ saturation: -100 })
  assert.equal(r, g)
  assert.equal(r, b)
  const warm = adjust({ warmth: 35 })
  assert.ok(warm[0] > 120 && warm[1] === 120 && warm[2] < 120)
  const tint = adjust({ tint: 35 })
  assert.ok(tint[0] > 120 && tint[1] < 120 && tint[2] === tint[0])
  const manual = { brightness: -10, warmth: 15, tint: -8 }
  for (const look of ['black-white', 'warm', 'cool', 'sepia', 'faded']) {
    const zero = adjust(manual, look, 0)
    const half = adjust(manual, look, 50)
    const full = adjust(manual, look, 100)
    assert.deepEqual(zero, adjust(manual))
    assert.notDeepEqual(full, zero)
    for (let c = 0; c < full.length; c++) assert.ok(Math.abs(half[c] - (zero[c] + full[c]) / 2) <= 1)
  }
})

test('effect padding follows image-local offsets and the image frame reserves card chrome', () => {
  const edits = {
    ...defaultImageEdits,
    outline: { enabled: true, colour: '#123456', width: 12 },
    shadow: { enabled: true, colour: '#000000', opacity: 100, x: 24, y: -18, blur: 8 },
  }
  assert.deepEqual(imageEffectInsets(edits), { left: 7, top: 43, right: 49, bottom: 7 })
  assert.deepEqual(imageFrameSize({ width: 300, height: 200, mode: 'card', caption: 'caption' }, 'front'), { x: 1, y: 27, width: 298, height: 152 })
  assert.deepEqual(imageFrameSize({ width: 300, height: 200, mode: 'direct', border: true }, 'front'), { x: 2, y: 2, width: 296, height: 196 })
  assert.deepEqual(imageFrameSize({ width: 300, height: 200, mode: 'card' }, 'back'), { x: 12, y: 90, width: 274, height: 102 })
})
