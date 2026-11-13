import assert from 'node:assert/strict'
import test from 'node:test'
import { audioPeakLimits, audioSourceKey, getCachedAudioPeaks, loadAudioPeaks, reduceAudioPeaks } from '../src/features/icanvas/audioPeaks.ts'

test('peak reduction combines absolute channel maxima without canceling opposite phase or skipping single samples', async () => {
  const frames = 8192
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  left[2050] = .25
  right[2050] = -.25
  right[6146] = -.875
  const peaks = await reduceAudioPeaks([left, right])
  assert.equal(peaks.length, audioPeakLimits.bins)
  assert.equal(peaks[512], .25)
  assert.equal(peaks[1536], .875)
  assert.equal(peaks.filter(Boolean).length, 2)
})

test('audio identity includes the algorithm and audio revision rather than appearance or the object URL', () => {
  const source = { id: 'asset-1', name: 'Same title.mp3', size: 1024, mime: 'audio/mpeg' }
  assert.equal(audioSourceKey(source), audioSourceKey({ ...source, name: 'Renamed copy.mp3' }))
  assert.notEqual(audioSourceKey(source), audioSourceKey({ ...source, id: 'asset-2' }))
  assert.notEqual(audioSourceKey(source, { lastModified: 4 }), audioSourceKey(source, { lastModified: 5 }))
  assert.notEqual(audioSourceKey(source), audioSourceKey(source, { lastModified: 4 }))
})

test('refuses missing metadata, oversized and cancelled sources without reading the encoded bytes', async () => {
  const encoded = new Blob(['a'])
  encoded.arrayBuffer = () => { throw new Error('This test must not read the source') }
  const missing = await loadAudioPeaks({ blob: encoded, key: 'invalid' }, Number.POSITIVE_INFINITY)
  assert.equal(missing.status, 'unavailable')
  assert.match(missing.reason, /reliable duration/)
  const refused = await loadAudioPeaks({ blob: encoded, key: 'invalid' }, audioPeakLimits.seconds + .01)
  assert.equal(refused.status, 'unavailable')
  assert.match(refused.reason, /3 minutes/)
  const canceled = await loadAudioPeaks({ blob: encoded, key: 'invalid' }, 1, AbortSignal.abort())
  assert.equal(canceled.status, 'unavailable')
  assert.match(canceled.reason, /canceled/)
  assert.equal(getCachedAudioPeaks('invalid'), undefined)
})
