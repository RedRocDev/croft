import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { AudioLines, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import type WaveSurfer from 'wavesurfer.js'
import { formatAudioTime, resolvedAudioAppearance, type AudioAppearance } from './audioAppearance'
import { loadAudioPeaks, type AudioPeakResult } from './audioPeaks'
import './audio-player.css'

type Props = {
  url: string
  source: { blob: Blob; key: string }
  title: string
  appearance?: AudioAppearance
  dark?: boolean
  showTitle?: boolean
}

const barWidth = 4

function snapshot(media: HTMLAudioElement) {
  return { duration: Number.isFinite(media.duration) ? media.duration : 0, time: media.currentTime,
    playing: !media.paused && !media.ended, muted: media.muted, volume: media.volume, failed: !!media.error }
}

function timeFraction(event: PointerEvent<HTMLDivElement>) {
  return Math.max(0, Math.min(1, event.nativeEvent.offsetX / (event.currentTarget.clientWidth || 1)))
}

export function AudioPlayer(props: Props) {
  return <AudioTrack key={props.url} {...props} />
}

function AudioTrack({ url, source, title, appearance, dark = false, showTitle }: Props) {
  const media = useRef<HTMLAudioElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const renderer = useRef<WaveSurfer>(null)
  const drag = useRef<{ id: number; initialTime: number }>(undefined)
  const [state, setState] = useState({ duration: 0, time: 0, playing: false, muted: false, volume: 1, failed: false })
  const [decoded, setDecoded] = useState<{ duration: number; result: AudioPeakResult }>()
  const [attempt, retry] = useState(0)
  const [renderFailed, setRenderFailed] = useState(false)
  const [playError, setPlayError] = useState('')
  const [hoverTime, setHoverTime] = useState<number>()
  const { mode, waveColour, progressColour, playheadColour } = resolvedAudioAppearance(appearance, dark)
  const result = decoded?.duration === state.duration ? decoded.result : undefined
  const colours = useRef({ waveColour, progressColour, playheadColour })
  colours.current = { waveColour, progressColour, playheadColour }

  useEffect(() => {
    const element = media.current
    if (!element) return
    const reflect = () => setState(snapshot(element))
    const names = ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ended', 'volumechange', 'error']
    for (const name of names) element.addEventListener(name, reflect)
    reflect()
    return () => {
      for (const name of names) element.removeEventListener(name, reflect)
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [])

  useEffect(() => {
    if (mode !== 'waveform' || !state.duration || state.failed || result) return
    const controller = new AbortController()
    void loadAudioPeaks(source, state.duration, controller.signal).then(result => {
      if (!controller.signal.aborted) setDecoded({ duration: state.duration, result })
    }).catch(() => {
      if (!controller.signal.aborted) setDecoded({ duration: state.duration, result: { status: 'unavailable', reason: 'Croft could not read waveform data.' } })
    })
    return () => controller.abort()
  }, [mode, source, state.duration, state.failed, result, attempt])

  const peaks = result?.status === 'ready' ? result : undefined
  useEffect(() => {
    if (mode !== 'waveform' || !peaks || !surface.current || !media.current || state.failed || renderFailed) return
    const container = surface.current
    const element = media.current
    let active = true
    let wave: WaveSurfer | undefined
    let unsubscribe: (() => void) | undefined
    void import('wavesurfer.js').then(({ default: Wave }) => {
      if (!active) return
      const { waveColour, progressColour, playheadColour } = colours.current
      wave = Wave.create({ container, media: element, peaks: [peaks.peaks], duration: peaks.duration,
        // WaveSurfer scales bar widths to device pixels but passes the radius directly to roundRect.
        height: 36, barWidth, barGap: 2, barRadius: barWidth * Math.max(1, window.devicePixelRatio) / 2,
        barMinHeight: 0, waveColor: waveColour, progressColor: progressColour,
        cursorColor: playheadColour, cursorWidth: 2, normalize: false, interact: false,
        fillParent: true, autoScroll: false, autoCenter: false, hideScrollbar: true })
      renderer.current = wave
      unsubscribe = wave.on('error', () => { if (active) setRenderFailed(true) })
    }).catch(() => { if (active) setRenderFailed(true) })
    return () => {
      active = false
      unsubscribe?.()
      wave?.destroy()
      renderer.current = null
    }
  }, [mode, peaks, state.failed, renderFailed, attempt])

  useEffect(() => {
    renderer.current?.setOptions({ waveColor: waveColour, progressColor: progressColour, cursorColor: playheadColour })
  }, [waveColour, progressColour, playheadColour])

  useEffect(() => {
    if (mode === 'compact' || state.failed) {
      drag.current = undefined
      setHoverTime(undefined)
    }
  }, [mode, state.failed])

  function play() {
    const element = media.current
    if (!element) return
    setPlayError('')
    if (element.paused) void element.play().catch(error => {
      if (error?.name !== 'AbortError') setPlayError('This file could not be played. Check that its format is supported.')
    })
    else element.pause()
  }

  function seek(seconds: number) {
    const element = media.current
    if (element && state.duration) element.currentTime = Math.max(0, Math.min(seconds, state.duration))
  }

  function cancelDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return
    seek(drag.current.initialTime)
    drag.current = undefined
    setHoverTime(undefined)
  }

  function seekWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 5
    const offsets: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }
    if (event.key === ' ') play()
    else if (event.key === 'Home') seek(0)
    else if (event.key === 'End') seek(state.duration)
    else if (event.key in offsets) seek(state.time + offsets[event.key])
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const showingWave = mode === 'waveform' && !!peaks && !renderFailed && !state.failed
  const unavailable = renderFailed ? 'Waveform could not be displayed.' : result?.status === 'unavailable' ? result.reason : ''
  const usableDuration = state.duration > 0 && !state.failed
  return <section className="ic-audio-player" aria-label={`Audio player for ${title}`} data-media-control data-audio-mode={mode}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => { if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.stopPropagation() }}>
    <audio ref={media} src={url} preload="metadata" aria-label={title} hidden />
    {showTitle && <p className="ic-audio-title" title={title}><AudioLines aria-hidden="true" /><span>{title}</span></p>}
    {showingWave ? <div className="ic-audio-wave">
      <div ref={surface} className="ic-audio-wave-render" aria-hidden="true" />
      <div className="ic-audio-wave-target" role="slider" aria-label="Seek waveform" tabIndex={0} aria-valuemin={0}
        aria-valuemax={state.duration} aria-valuenow={Math.min(state.time, state.duration)}
        aria-valuetext={`${formatAudioTime(state.time)} of ${formatAudioTime(state.duration)}`} onKeyDown={seekWithKeys}
        onPointerDown={event => {
          if (event.button !== 0 || drag.current || !media.current) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { id: event.pointerId, initialTime: media.current.currentTime }
          // Events target this child-free overlay. offsetX is in local CSS units, even after the canvas transform.
          seek(timeFraction(event) * state.duration)
        }} onPointerMove={event => {
          const time = timeFraction(event) * state.duration
          setHoverTime(time)
          if (drag.current?.id === event.pointerId) seek(time)
        }} onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return
          drag.current = undefined
          seek(timeFraction(event) * state.duration)
        }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onPointerLeave={() => setHoverTime(undefined)} />
      {hoverTime !== undefined && <span className="ic-audio-hover" aria-hidden="true">{formatAudioTime(hoverTime)}</span>}
    </div> : usableDuration && <input className="ic-audio-seek" type="range" min={0} max={state.duration} step="any"
      value={Math.min(state.time, state.duration)} aria-label="Seek audio" aria-valuetext={formatAudioTime(state.time)}
      onChange={event => seek(event.currentTarget.valueAsNumber)} />}
    <div className="ic-audio-controls">
      <button type="button" className="ic-icon" aria-label={state.playing ? 'Pause audio' : 'Play audio'}
        title={state.playing ? 'Pause' : 'Play'} disabled={state.failed} onClick={play}>
        {state.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <span className="ic-audio-time" aria-label="Playback time">{formatAudioTime(state.time)} / {usableDuration ? formatAudioTime(state.duration) : '–:––'}</span>
      <button type="button" className="ic-icon ic-audio-mute" aria-label={state.muted ? 'Unmute audio' : 'Mute audio'}
        aria-pressed={state.muted} disabled={state.failed} onClick={() => { if (media.current) media.current.muted = !media.current.muted }}>
        {state.muted || !state.volume ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
      </button>
      <input className="ic-audio-volume" type="range" min={0} max={1} step={.05} aria-label="Audio volume" value={state.muted ? 0 : state.volume}
        disabled={state.failed} onChange={event => { if (media.current) { media.current.muted = false; media.current.volume = event.currentTarget.valueAsNumber } }} />
    </div>
    {state.failed || playError ? <p className="ic-audio-status" role="status">{playError || 'This audio file is damaged or unsupported.'}</p> :
      mode === 'waveform' && !showingWave && <p className="ic-audio-status" role="status">
        {unavailable || (state.duration ? 'Preparing waveform…' : 'Loading audio…')}
        {unavailable && <button type="button" onClick={() => { setDecoded(undefined); setRenderFailed(false); retry(count => count + 1) }}>Retry waveform</button>}
      </p>}
  </section>
}
