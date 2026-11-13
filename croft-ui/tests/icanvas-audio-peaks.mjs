import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))
const fixtures = await Promise.all(['CROFT_QA_VBR_MP3', 'CROFT_QA_UNINDEXED_MP3'].map(async variable => {
  const path = process.env[variable]
  return path ? (await readFile(path)).toString('base64') : null
}))
const browser = await chromium.launch({ ...(process.env.CROFT_QA_CHROME ? { executablePath: process.env.CROFT_QA_CHROME } : { channel: 'chrome' }), chromiumSandbox: true })

try {
  const page = await browser.newPage()
  const requests = []
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) requests.push(request.url())
  })
  await page.goto(origin)
  const result = await page.evaluate(async ([mp3, unindexed]) => {
    const { audioPeakLimits, audioSourceKey, getCachedAudioPeaks, loadAudioPeaks, measureAudioSource } = await import('/src/features/icanvas/audioPeaks.ts')
    function stereoWave() {
      const rate = 16_000
      const sampleCount = rate * 4
      const data = new DataView(new ArrayBuffer(44 + sampleCount * 4))
      const fourcc = (offset, text) => [...text].forEach((char, index) => data.setUint8(offset + index, char.charCodeAt(0)))
      fourcc(0, 'RIFF'); data.setUint32(4, data.byteLength - 8, true); fourcc(8, 'WAVE'); fourcc(12, 'fmt ')
      data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true); data.setUint32(24, rate, true)
      data.setUint32(28, 4 * rate, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true)
      fourcc(36, 'data'); data.setUint32(40, sampleCount * 4, true)
      for (let frame = 0; frame < sampleCount; frame += 1) {
        const magnitude = frame === 3 * rate + 500 ? .98 : frame >= rate && frame < 2 * rate ? .24 : frame >= 2 * rate && frame < 3 * rate ? .72 : 0
        const sample = Math.round(magnitude * (frame % 13 < 6 ? -1 : 1) * 32767)
        data.setInt16(44 + frame * 4, sample, true)
        data.setInt16(46 + frame * 4, -sample, true)
      }
      return new Blob([data.buffer], { type: 'audio/wav' })
    }

    const encodeAlgorithm = { name: 'SHA-256' }
    const bytes = stereoWave()
    const asset = { name: 'synthetic.wav', id: 'qa-source', size: bytes.size, mime: bytes.type }
    const key = audioSourceKey(asset)
    const imported = { key, blob: bytes }
    const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest(encodeAlgorithm, await blob.arrayBuffer())))
    const prior = await digest(bytes)
    const duration = await measureAudioSource(bytes)
    const original = OfflineAudioContext.prototype.decodeAudioData
    let calls = 0
    OfflineAudioContext.prototype.decodeAudioData = function (...args) { calls++; return original.apply(this, args) }
    const start = performance.now()
    const [wave, shared] = await Promise.all([loadAudioPeaks(imported, duration), loadAudioPeaks(imported, duration)])
    const elapsedMs = Number((performance.now() - start).toFixed(1))
    if (wave.status !== 'ready') throw new Error(wave.reason)
    const solid = (begin, end) => Math.max(...wave.peaks.slice(Math.floor(wave.peaks.length * begin), Math.floor(wave.peaks.length * end)))
    const report = {
      duration, durationDecoded: wave.duration, encodedBytes: bytes.size, elapsedMs, bins: wave.peaks.length,
      amplitudes: [solid(.01, .24), solid(.26, .48), solid(.52, .74), solid(.75, .80), solid(.88, .97)],
      decodeCallsForTwoInstances: calls, sameResult: wave === shared && wave === getCachedAudioPeaks(key, duration),
      originalBytes: JSON.stringify(prior) === JSON.stringify(await digest(bytes)),
      changedRevision: audioSourceKey(asset, { lastModified: 10 }) !== audioSourceKey(asset, { lastModified: 11 }),
      cacheMismatch: (await loadAudioPeaks(imported, 9)).status,
    }
    const tooLong = await loadAudioPeaks({ ...imported, key: 'long' }, audioPeakLimits.seconds + 1)
    const tooLarge = await loadAudioPeaks({ key: 'large', blob: new Blob([new Uint8Array(audioPeakLimits.encodedBytes + 1)]) }, 1)
    const corrupted = await loadAudioPeaks({ key: 'corrupt', blob: new Blob(['Not audio.'], { type: 'audio/wav' }) }, .1)
    if (tooLong.status !== 'unavailable' || tooLarge.status !== 'unavailable' || corrupted.status !== 'unavailable') throw new Error('A guarded source returned waveform data.')
    report.fallbacks = [tooLong.reason, tooLarge.reason, corrupted.reason]

    // Stall the active decoder while the queue fills so the guard and queued cancellation are reproducible.
    let release
    const hold = new Promise(resolve => { release = resolve })
    let activeCalls = 0
    OfflineAudioContext.prototype.decodeAudioData = async function (...args) {
      activeCalls++
      await hold
      return original.apply(this, args)
    }
    const running = loadAudioPeaks({ ...imported, key: 'held' }, duration)
    const waiting = Array.from({ length: audioPeakLimits.queuedSources }, () => new AbortController())
    const queued = waiting.map((controller, index) => loadAudioPeaks({ ...imported, key: `waiting-${index}` }, duration, controller.signal))
    const full = await loadAudioPeaks({ ...imported, key: 'queue-limit' }, duration)
    waiting.forEach(controller => controller.abort())
    release()
    if ((await running).status !== 'ready') throw new Error('The permitted queue job failed.')
    report.queueFallback = full.status === 'unavailable' && full.reason.includes('queue')
    report.queuedCanceled = (await Promise.all(queued)).every(result => result.status === 'unavailable' && result.reason.includes('canceled'))
    report.activeCalls = activeCalls
    OfflineAudioContext.prototype.decodeAudioData = original

    const compressed = async () => {
      const context = new AudioContext()
      try {
        const destination = context.createMediaStreamDestination()
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        gain.gain.value = .35
        oscillator.connect(gain).connect(destination)
        const silentOutput = context.createGain()
        silentOutput.gain.value = 0
        oscillator.connect(silentOutput).connect(context.destination)
        const mimeType = 'audio/mp4;codecs=mp4a.40.2'
        const recorder = new MediaRecorder(destination.stream, { mimeType })
        await context.resume()
        return await new Promise((resolve, reject) => {
          const chunks = []
          recorder.ondataavailable = event => chunks.push(event.data)
          recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/mp4' }))
          recorder.onerror = reject
          oscillator.start()
          recorder.start(200)
          setTimeout(() => { recorder.stop(); oscillator.stop() }, 1250)
        })
      } finally { await context.close() }
    }

    async function checkRecording(blob, key, checkSeeking = false) {
      const observed = await measureAudioSource(blob)
      const decoded = await loadAudioPeaks({ key, blob }, observed)
      if (decoded.status !== 'ready') return { size: blob.size, observed, status: decoded.status, reason: decoded.reason }
      const report = { size: blob.size, observed, status: decoded.status, decodedDuration: decoded.decodedDuration, peak: Math.max(...decoded.peaks) }
      if (!checkSeeking) return report

      const audio = new Audio()
      const url = URL.createObjectURL(blob)
      function waitFor(event) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`MP3 ${event} timeout.`)), 3000)
          audio.addEventListener(event, () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
      try {
        const ready = waitFor('loadedmetadata')
        audio.src = url
        await ready
        report.seeks = []
        for (const fraction of [.25, .5, .75]) {
          const seeked = waitFor('seeked')
          const target = audio.duration * fraction
          audio.currentTime = target
          await seeked
          const bin = Math.floor(audio.currentTime / decoded.duration * decoded.peaks.length)
          report.seeks.push({ fraction, target, actual: audio.currentTime,
            peakNearTime: Math.max(...decoded.peaks.slice(Math.max(0, bin - 8), bin + 9)) })
        }
      } finally {
        audio.removeAttribute('src')
        audio.load()
        URL.revokeObjectURL(url)
      }
      return report
    }
    if (MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2')) {
      report.aac = await checkRecording(await compressed(), 'real-aac')
    }
    if (mp3) {
      const encoded = Uint8Array.from(atob(mp3), character => character.charCodeAt(0))
      const blob = new Blob([encoded], { type: 'audio/mpeg' })
      report.mp3 = await checkRecording(blob, 'real-variable-bitrate-mp3', true)
      // A misleading seek table should not send several minutes of compressed frames to the decoder.
      const expanded = new Blob(Array.from({ length: 65 }, () => encoded), { type: 'audio/mpeg' })
      const denied = await loadAudioPeaks({ key: 'understated duration', blob: expanded }, report.mp3.observed)
      report.fakeIndexGuard = denied.status === 'unavailable' && denied.reason.includes('decoding limits')
    }
    if (unindexed) {
      const blob = new Blob([Uint8Array.from(atob(unindexed), character => character.charCodeAt(0))], { type: 'audio/mpeg' })
      report.unindexed = await checkRecording(blob, 'unindexed-mp3')
    }
    return report
  }, fixtures)
  assert.equal(result.duration, 4)
  assert.equal(result.durationDecoded, 4)
  assert.equal(result.bins, 2048)
  assert.equal(result.amplitudes[0], 0)
  assert.ok(Math.abs(result.amplitudes[1] - .24) < .005)
  assert.ok(Math.abs(result.amplitudes[2] - .72) < .005)
  assert.ok(Math.abs(result.amplitudes[3] - .98) < .005)
  assert.equal(result.amplitudes[4], 0)
  assert.equal(result.decodeCallsForTwoInstances, 1)
  assert.equal(result.activeCalls, 1)
  assert.equal(result.sameResult, true)
  assert.equal(result.originalBytes, true)
  assert.equal(result.changedRevision, true)
  assert.equal(result.cacheMismatch, 'unavailable')
  assert.equal(result.queueFallback, true)
  assert.equal(result.queuedCanceled, true)
  assert.match(result.fallbacks[0], /3 minutes/)
  assert.match(result.fallbacks[1], /24 MiB/)
  assert.match(result.fallbacks[2], /could not decode/)
  if (result.aac) {
    assert.equal(result.aac.status, 'ready', JSON.stringify(result.aac))
    assert.ok(result.aac.peak > .2)
  }
  if (fixtures[0]) {
    assert.equal(result.mp3.status, 'ready', JSON.stringify(result.mp3))
    assert.ok(result.mp3.peak > .15)
    assert.ok(Math.abs(result.mp3.observed - result.mp3.decodedDuration) <= .06)
    assert.ok(result.mp3.seeks.every(seek => Math.abs(seek.actual - seek.target) <= .06))
    assert.ok(result.mp3.seeks[0].peakNearTime < .01)
    assert.ok(result.mp3.seeks[1].peakNearTime > .12)
    assert.ok(result.mp3.seeks[2].peakNearTime > result.mp3.seeks[1].peakNearTime + .08)
    assert.equal(result.fakeIndexGuard, true)
  }
  if (fixtures[1]) {
    assert.equal(result.unindexed.status, 'unavailable', JSON.stringify(result.unindexed))
    assert.match(result.unindexed.reason, /durations differ/)
  }
  assert.ok(result.aac || result.mp3, 'Run on an AAC-capable Chrome or provide the optional indexed MP3 fixture.')
  assert.deepEqual(requests, [])
  console.log(`Chrome ${browser.version()} audio peak evidence`, JSON.stringify(result))
} finally { await browser.close() }
