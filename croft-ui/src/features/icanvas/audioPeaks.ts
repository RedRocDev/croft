export const audioPeakLimits = {
  version: 1,
  encodedBytes: 24 * 1024 * 1024,
  pcmBytes: 96 * 1024 * 1024,
  seconds: 180,
  bins: 2048,
  cachedSources: 64,
  queuedSources: 6,
} as const

type AudioSource = { blob: Blob; key: string }
type SourceIdentity = { id: string; name: string; size: number; mime: string }
export type AudioPeaks = { status: 'ready'; version: 1; duration: number; decodedDuration: number; peaks: Float32Array }
export type AudioPeakResult = AudioPeaks | { status: 'unavailable'; reason: string }

export function audioSourceKey(asset: SourceIdentity, linkedFile?: Pick<File, 'lastModified'>) {
  return JSON.stringify(linkedFile ? [audioPeakLimits.version, asset.id, asset.name, asset.size, asset.mime, linkedFile.lastModified]
    : [audioPeakLimits.version, asset.id, asset.size, asset.mime])
}

const cache = new Map<string, AudioPeaks>()
const unavailable = (reason: string): AudioPeakResult => ({ status: 'unavailable', reason })
const canceled = () => unavailable('Waveform request canceled.')
const durationMismatch = () => unavailable('The waveform and playback durations differ. Compact playback is available.')
const durationMatches = (first: number, second: number) =>
  Math.abs(first - second) <= Math.max(.06, Math.min(.25, first * .002))
const matchesPlayback = (result: AudioPeakResult, duration: number) => result.status === 'ready' && !durationMatches(duration, result.duration)
  ? durationMismatch() : result

export function getCachedAudioPeaks(key: string, mediaDuration?: number) {
  const result = cache.get(key)
  if (!result || mediaDuration !== undefined && !durationMatches(mediaDuration, result.duration)) return undefined
  cache.delete(key)
  cache.set(key, result)
  return result
}

/** Probes the browser's playback clock before attempting a full audio decode. */
export function measureAudioSource(blob: Blob, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (typeof Audio === 'undefined') return Promise.reject(new Error('Local waveform rendering needs an audio-capable browser.'))
  return new Promise<number>((resolve, reject) => {
    const audio = new Audio()
    const url = URL.createObjectURL(blob)
    const timeout = setTimeout(() => fail('The browser could not read the track duration.'), 8000)
    function cleanup() {
      clearTimeout(timeout)
      audio.removeEventListener('loadedmetadata', ready)
      audio.removeEventListener('error', failed)
      signal?.removeEventListener('abort', abort)
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
    }
    function fail(message: string) {
      cleanup()
      reject(new Error(message))
    }
    function failed() { fail('The browser could not read this audio format or the file is damaged.') }
    function abort() { cleanup(); reject(signal?.reason) }
    function ready() {
      const duration = audio.duration
      if (!Number.isFinite(duration) || duration <= 0) {
        fail('This track has no reliable duration for a waveform.')
        return
      }
      cleanup()
      resolve(duration)
    }
    audio.preload = 'metadata'
    audio.addEventListener('loadedmetadata', ready)
    audio.addEventListener('error', failed)
    signal?.addEventListener('abort', abort, { once: true })
    audio.src = url
  })
}

type FormatEstimate = { channels: number; rate: number; duration?: number; mp3Start?: number }
const signature = (data: DataView, offset: number, value: string) =>
  offset + value.length <= data.byteLength && Array.from(value).every((letter, index) => data.getUint8(offset + index) === letter.charCodeAt(0))

function waveEstimate(data: DataView): FormatEstimate | undefined {
  if (!signature(data, 0, 'RIFF') || !signature(data, 8, 'WAVE')) return undefined
  let estimate: FormatEstimate | undefined
  let blockAlign = 0
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const size = data.getUint32(offset + 4, true)
    if (signature(data, offset, 'fmt ') && size >= 16 && offset + 24 <= data.byteLength) {
      const encoding = data.getUint16(offset + 8, true)
      const channels = data.getUint16(offset + 10, true)
      const rate = data.getUint32(offset + 12, true)
      blockAlign = data.getUint16(offset + 20, true)
      const bits = data.getUint16(offset + 22, true)
      if (![1, 3, 65534].includes(encoding) || !channels || !rate || blockAlign !== channels * Math.ceil(bits / 8) || !blockAlign) return undefined
      estimate = { channels, rate }
    }
    if (estimate && signature(data, offset, 'data')) return { ...estimate, duration: size / blockAlign / estimate.rate }
    offset += 8 + size + (size % 2)
  }
  return estimate
}

function flacEstimate(data: DataView): FormatEstimate | undefined {
  if (!signature(data, 0, 'fLaC') || data.byteLength < 42 || (data.getUint8(4) & 127) !== 0) return undefined
  const streamInfoHigh = data.getUint32(18)
  const rate = streamInfoHigh >>> 12
  if (!rate) return undefined
  const channels = ((streamInfoHigh >>> 9) & 7) + 1
  const totalSamples = (streamInfoHigh & 15) * 0x100000000 + data.getUint32(22)
  return { channels, rate, duration: totalSamples ? totalSamples / rate : undefined }
}

const mp3Rates = [44_100, 48_000, 32_000]
const mp3FullBitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const mp3LowBitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

function mp3Frame(data: DataView, offset: number) {
  if (offset + 4 > data.byteLength) return undefined
  const first = data.getUint16(offset)
  const second = data.getUint16(offset + 2)
  const version = (first >>> 3) & 3
  const layer = (first >>> 1) & 3
  const rateIndex = (second >>> 10) & 3
  const bitrateIndex = second >>> 12
  if ((first & 0xffe0) !== 0xffe0 || version === 1 || layer !== 1 || rateIndex === 3 || !bitrateIndex || bitrateIndex === 15) return undefined
  const rate = mp3Rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const bitrate = (version === 3 ? mp3FullBitrates : mp3LowBitrates)[bitrateIndex]
  const bytes = Math.floor((version === 3 ? 144_000 : 72_000) * bitrate / rate) + ((second >>> 9) & 1)
  return { rate, bytes, samples: version === 3 ? 1152 : 576, channels: ((second >>> 6) & 3) === 3 ? 1 : 2 }
}

async function inspectAudio(blob: Blob): Promise<FormatEstimate> {
  const data = new DataView(await blob.slice(0, 64 * 1024).arrayBuffer())
  const recognised = waveEstimate(data) ?? flacEstimate(data)
  if (recognised) return recognised
  const fallback = { channels: 8, rate: 192_000 }
  if (!blob.type.toLowerCase().startsWith('audio/mpeg') && !signature(data, 0, 'ID3') && !mp3Frame(data, 0)) return fallback

  let offset = 0
  if (signature(data, 0, 'ID3') && data.byteLength >= 10) {
    const tagSize = [6, 7, 8, 9].reduce((size, index) => size * 128 + (data.getUint8(index) & 127), 0)
    offset = 10 + tagSize + (data.getUint8(5) & 16 ? 10 : 0)
  }
  const regionStart = offset
  const frames = offset + 4096 < data.byteLength ? data : new DataView(await blob.slice(offset, offset + 4096).arrayBuffer())
  if (frames !== data) offset = 0
  const end = Math.min(offset + 512, frames.byteLength)
  for (; offset < end; offset += 1) {
    const first = mp3Frame(frames, offset)
    const second = first && mp3Frame(frames, offset + first.bytes)
    if (first && second?.rate === first.rate) return { rate: first.rate, channels: Math.max(first.channels, second.channels),
      mp3Start: frames === data ? offset : regionStart + offset }
  }
  return fallback
}

function countMp3Frames(encoded: ArrayBuffer, start: number): FormatEstimate {
  const bytes = new DataView(encoded)
  let rate = 0
  let channels = 0
  let duration = 0
  let offset = start
  while (offset + 4 <= bytes.byteLength) {
    const frame = mp3Frame(bytes, offset)
    if (!frame || offset + frame.bytes > bytes.byteLength) break
    duration += frame.samples / frame.rate
    rate = Math.max(rate, frame.rate)
    channels = Math.max(channels, frame.channels)
    if (duration > audioPeakLimits.seconds || duration * rate * channels * Float32Array.BYTES_PER_ELEMENT > audioPeakLimits.pcmBytes) break
    offset += frame.bytes
  }
  const remaining = bytes.byteLength - offset
  // Allow an ID3 footer or a few encoder padding bytes. Other interrupted frame streams need Compact playback.
  if (duration <= audioPeakLimits.seconds && (remaining > 128 || remaining === 128 && !signature(bytes, offset, 'TAG'))) {
    return { rate, channels, duration: Infinity }
  }
  return { rate, channels, duration }
}

function exceedsDecodeBudget(info: FormatEstimate, mediaDuration: number) {
  const duration = Math.max(mediaDuration, info.duration ?? 0)
  const pcmBytes = duration * info.channels * info.rate * Float32Array.BYTES_PER_ELEMENT
  return info.channels > 8 || info.rate > 192_000 || duration > audioPeakLimits.seconds || pcmBytes > audioPeakLimits.pcmBytes
}

/** Takes the strongest absolute sample across channels in each time bucket. */
export async function reduceAudioPeaks(channels: readonly Float32Array[], active: () => boolean = () => true) {
  const length = channels[0]?.length ?? 0
  const bins = Math.min(length, audioPeakLimits.bins)
  const peaks = new Float32Array(bins)
  let previousYield = performance.now()
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor(bin * length / bins)
    const end = Math.floor((bin + 1) * length / bins)
    let peak = 0
    for (const channel of channels) {
      for (let frame = start; frame < end; frame += 1) {
        const magnitude = Math.abs(channel[frame])
        if (magnitude > peak) peak = magnitude
      }
    }
    peaks[bin] = Math.min(1, peak)
    if (bin % 32 === 31 && performance.now() - previousYield > 12) {
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!active()) break
      previousYield = performance.now()
    }
  }
  return peaks
}

type Listener = { finish: (result: AudioPeakResult) => void }
type Job = { source: AudioSource; duration: number; listeners: Set<Listener> }
const jobs = new Map<string, Job>()
let activeJob: Job | undefined

async function decodePeaks(job: Job): Promise<AudioPeakResult> {
  const { source, duration, listeners } = job
  const info = await inspectAudio(source.blob)
  const budgetError = 'This track falls outside the waveform decoding limits. Compact playback is available.'
  if (exceedsDecodeBudget(info, duration)) return unavailable(budgetError)
  if (!listeners.size) return canceled()
  if (typeof OfflineAudioContext === 'undefined') return unavailable('This browser cannot decode a waveform. Compact playback is available.')

  // The offline context resamples decoded frames without creating an audible source. Browser
  // decoders may still use native-rate memory during decoding, which is why the estimate uses it.
  const encoded = await source.blob.arrayBuffer()
  if (!listeners.size) return canceled()
  // Verify the frame count before trusting an MP3 seek table's advertised media duration.
  if (info.mp3Start !== undefined && exceedsDecodeBudget(countMp3Frames(encoded, info.mp3Start), duration)) {
    return unavailable(budgetError)
  }
  const context = new OfflineAudioContext(1, 1, Math.min(48_000, Math.max(8_000, info.rate)))
  const buffer = await context.decodeAudioData(encoded)
  if (!listeners.size) return canceled()
  if (!durationMatches(duration, buffer.duration)) return durationMismatch()
  if (buffer.numberOfChannels > 8 || buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > audioPeakLimits.pcmBytes) {
    return unavailable('The decoded audio exceeds the waveform limit. Compact playback is available.')
  }

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  const peaks = await reduceAudioPeaks(channels, () => listeners.size > 0)
  return listeners.size && peaks.length ? { status: 'ready', version: 1, duration, decodedDuration: buffer.duration, peaks } : canceled()
}

function nextJob() {
  if (activeJob) return
  const job = jobs.values().next().value as Job | undefined
  if (!job) return
  activeJob = job
  void decodePeaks(job).catch(() => unavailable('The browser could not decode this waveform. Try Compact playback.')).then(result => {
    if (result.status === 'ready') {
      if (cache.size >= audioPeakLimits.cachedSources) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(job.source.key, result)
    }
    jobs.delete(job.source.key)
    activeJob = undefined
    for (const listener of job.listeners) listener.finish(result)
    nextJob()
  })
}

export function loadAudioPeaks(source: AudioSource, mediaDuration: number, signal?: AbortSignal): Promise<AudioPeakResult> {
  if (signal?.aborted) return Promise.resolve(canceled())
  if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return Promise.resolve(unavailable('This track has no reliable duration for a waveform.'))
  if (source.blob.size > audioPeakLimits.encodedBytes || mediaDuration > audioPeakLimits.seconds) {
    return Promise.resolve(unavailable('Waveforms are limited to files up to 24 MiB and tracks up to 3 minutes. Compact playback is available.'))
  }
  const cached = getCachedAudioPeaks(source.key)
  if (cached) return Promise.resolve(matchesPlayback(cached, mediaDuration))

  let job = jobs.get(source.key)
  if (!job) {
    if (jobs.size >= audioPeakLimits.queuedSources + Number(!!activeJob)) {
      return Promise.resolve(unavailable('Other waveforms are loading. Retry when the queue clears.'))
    }
    job = { source, duration: mediaDuration, listeners: new Set() }
    jobs.set(source.key, job)
  }

  return new Promise(resolve => {
    const pending = job!
    function abort() {
      pending.listeners.delete(listener)
      if (pending !== activeJob && !pending.listeners.size) jobs.delete(source.key)
      resolve(canceled())
    }
    const listener: Listener = {
      finish(result) {
        signal?.removeEventListener('abort', abort)
        resolve(matchesPlayback(result, mediaDuration))
      },
    }
    pending.listeners.add(listener)
    signal?.addEventListener('abort', abort, { once: true })
    nextJob()
  })
}
