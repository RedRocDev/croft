import { ChevronDown, ChevronRight, Crop, Pipette, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useAssetUrl } from './CanvasVisuals'
import { ImageCropDialog } from './ImageCropDialog'
import { defaultImageEdits, imageLookNames, type ImageEdits } from './imageEdits'
import { loadImage, renderEditedImage, sampleRenderedImage } from './imageRendering'
import { maxProjectSwatches, maxSwatchNameLength } from './imagePersistence'
import type { ProjectSwatch } from './model'
import './image-tools.css'

export type ImageToolSection = 'crop' | 'adjust' | 'looks' | 'effects' | 'colours'
export type ImageToolRequest = { section: 'crop' | 'adjust' | 'effects'; tick: number }
type ToolProps = {
  assetId: string; edits?: ImageEdits; sectionRequest?: ImageToolRequest
  width: number; height: number; disabled: boolean; swatches: readonly ProjectSwatch[]
  onPreview: (edits: ImageEdits | undefined) => void; onCommit: (edits: ImageEdits | undefined) => void
  onCompare: (enabled: boolean) => void; onSwatches: (swatches: ProjectSwatch[]) => void; onRelink?: () => void
}

const sections: { id: ImageToolSection; title: string }[] = [
  { id: 'crop', title: 'Crop & Shape' }, { id: 'adjust', title: 'Adjust' }, { id: 'looks', title: 'Looks' },
  { id: 'effects', title: 'Effects' }, { id: 'colours', title: 'Colours' },
]
const toneControls = [
  { key: 'brightness', label: 'Brightness' }, { key: 'contrast', label: 'Contrast' }, { key: 'saturation', label: 'Saturation' },
  { key: 'warmth', label: 'Warmth' }, { key: 'tint', label: 'Tint' },
] as const
const lookLabels: Record<ImageEdits['look']['name'], string> = { original: 'Original', 'black-white': 'Black & White', warm: 'Warm', cool: 'Cool', sepia: 'Sepia', faded: 'Faded' }
const fileProblems = { prompt: 'File permission needed', denied: 'File access denied', missing: 'File missing or moved',
  changed: 'File changed since it was linked', unavailable: 'File unavailable' }

export function ImageTools({ assetId, edits, sectionRequest, width, height, disabled, swatches, onPreview, onCommit, onCompare, onSwatches, onRelink }: ToolProps) {
  const media = useAssetUrl(assetId)
  const url = media.url
  const [decoded, setDecoded] = useState<{ url: string; photo?: HTMLImageElement }>()
  const photo = decoded?.url === url ? decoded?.photo : undefined
  const imageError = !!url && decoded?.url === url && !photo
  const [active, setActive] = useState<ImageToolSection>()
  const [cropOpen, setCropOpen] = useState(false)
  const [comparing, setComparing] = useState(false)
  const instance = useId()
  const rules = useRef(new Map<ImageToolSection, HTMLButtonElement>())
  const current = edits ?? defaultImageEdits
  const writable = !disabled && !!photo
  const requestRef = useRef<number>(undefined)

  useEffect(() => {
    if (!url) return
    let cancelled = false
    void loadImage(url).then(photo => { if (!cancelled) setDecoded({ url, photo }) }, () => {
      if (!cancelled) setDecoded({ url })
    })
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    if (!sectionRequest || requestRef.current === sectionRequest.tick) return
    setActive(sectionRequest.section)
    if (sectionRequest.section === 'crop' && !disabled && !photo && !imageError && !media.problem) return
    requestRef.current = sectionRequest.tick
    if (sectionRequest.section === 'crop' && writable) setCropOpen(true)
    else rules.current.get(sectionRequest.section)?.focus()
  }, [sectionRequest, photo, writable, imageError, media.problem, disabled])

  function compare(enabled: boolean) {
    setComparing(enabled)
    onCompare(enabled)
  }

  function preview(next: ImageEdits | undefined) {
    if (!writable) return
    if (comparing) compare(false)
    onPreview(next)
  }

  function commit(next: ImageEdits | undefined) {
    if (disabled || next && !photo) return
    if (comparing) compare(false)
    onCommit(next)
  }

  function setting<Key extends keyof ImageEdits>(key: Key, value: ImageEdits[Key]) {
    return { ...current, [key]: value }
  }

  function numeric(label: string, value: number, neutral: number, min: number, max: number, set: (number: number) => ImageEdits, step?: number) {
    return <EditNumber key={label} {...{ label, value, neutral, min, max, step }}
      preview={number => preview(number === undefined ? undefined : set(number))} commit={number => commit(set(number))} />
  }

  const sourceMismatch = photo && current.crop && current.source &&
    (photo.naturalWidth !== current.source.width || photo.naturalHeight !== current.source.height)
  const issue = media.requestProblem ?? media.problem

  return <section className="ic-image-tools" aria-label="Image Tools" onKeyDown={event => {
    if (event.key === 'Escape' && comparing) { event.preventDefault(); compare(false) }
    if (event.key === 'Escape' || !event.ctrlKey && !event.metaKey) event.stopPropagation()
  }} onPointerDown={event => event.stopPropagation()}>
    <h3>Image Tools</h3>
    {issue && <div className="ic-image-tools-source">
      <p role="status">{fileProblems[issue]}</p>
      <div className="ic-row">
        {media.restoreAccess && (issue === 'prompt' || issue === 'denied')
          ? <button type="button" className="ic-button" disabled={media.requesting} onClick={() => void media.restoreAccess?.()}>{media.requesting ? 'Waiting for browser…' : 'Restore access'}</button>
          : <button type="button" className="ic-button" onClick={media.retry}>Check again</button>}
        {onRelink && !disabled && <button type="button" className="ic-button" onClick={onRelink}>Relink File</button>}
      </div>
    </div>}
    {imageError && <p className="ic-error" role="status">This source image could not be decoded.</p>}
    {sourceMismatch && <p className="ic-error" role="status">The source dimensions changed. Open Crop &amp; Straighten to update the crop.</p>}
    {sections.map(({ id, title }) => <div key={id} className="ic-image-tools-section">
      <button type="button" className="ic-image-section-trigger" aria-expanded={active === id} aria-controls={`${instance}-${id}`}
        ref={element => { if (element) rules.current.set(id, element); else rules.current.delete(id) }}
        onClick={() => setActive(value => value === id ? undefined : id)}>{active === id ? <ChevronDown /> : <ChevronRight />}{title}</button>
      <div id={`${instance}-${id}`} hidden={active !== id}>
      {active === id && <fieldset className="ic-image-tool-fields" aria-label={title} disabled={id !== 'colours' && !writable}>
        {id === 'crop' && <>
          <button type="button" className="ic-button" onClick={() => { compare(false); setCropOpen(true) }}><Crop />Crop &amp; Straighten</button>
          <label className="ic-inspector-field"><span>Shape mask</span><select value={current.mask.shape}
            onChange={event => commit(setting('mask', { ...current.mask, shape: event.currentTarget.value as ImageEdits['mask']['shape'] }))}>
            <option value="none">None / Rectangle</option><option value="circle">Circle</option><option value="oval">Oval</option><option value="rounded">Rounded Rectangle</option>
          </select></label>
          {current.mask.shape === 'rounded' && numeric('Corner radius (%)', current.mask.radius, defaultImageEdits.mask.radius, 0, 50,
            value => setting('mask', { ...current.mask, radius: value }))}
          {numeric('Image position X (%)', Math.round(current.mask.x * 100), 0, -100, 100, value => setting('mask', { ...current.mask, x: value / 100 }))}
          {numeric('Image position Y (%)', Math.round(current.mask.y * 100), 0, -100, 100, value => setting('mask', { ...current.mask, y: value / 100 }))}
          {numeric('Image scale (%)', Math.round(current.mask.scale * 100), 100, 100, 300, value => setting('mask', { ...current.mask, scale: value / 100 }))}
          <button className="ic-button" type="button" onClick={() => commit(setting('mask', defaultImageEdits.mask))}>Reset shape &amp; framing</button>
        </>}
        {id === 'adjust' && <>
          {toneControls.map(({ key, label }) => numeric(label, current.tone[key], 0, -100, 100, value => setting('tone', { ...current.tone, [key]: value })))}
          <button className="ic-button" type="button" onClick={() => commit(setting('tone', defaultImageEdits.tone))}>Reset adjustments</button>
        </>}
        {id === 'looks' && <>
          <div className="ic-image-looks" role="group" aria-label="Image looks">
            {imageLookNames.map(name => <button key={name} type="button" aria-pressed={current.look.name === name}
              onClick={() => { if (current.look.name !== name) commit(setting('look', { ...current.look, name })) }}>
              {photo && <ImageLookPreview {...{ photo, name, width, height }} edits={current} />}
              <span>{lookLabels[name]}</span>
            </button>)}
          </div>
          <p className="ic-image-help">Original removes the look and keeps your other edits.</p>
          <fieldset className="ic-image-tool-fields" disabled={current.look.name === 'original'}>
            {numeric('Look intensity (%)', current.look.intensity, 100, 0, 100, value => setting('look', { ...current.look, intensity: value }))}
          </fieldset>
          <button className="ic-button" type="button" onClick={() => commit(setting('look', defaultImageEdits.look))}>Reset look</button>
        </>}
        {id === 'effects' && <>
          <label className="ic-inspector-check"><span>Outline</span><input type="checkbox" checked={current.outline.enabled}
            onChange={event => commit(setting('outline', { ...current.outline, enabled: event.currentTarget.checked }))} /></label>
          {current.outline.enabled && <>
            <EffectColour label="Outline colour" colour={current.outline.colour} {...{ swatches }} change={colour => commit(setting('outline', { ...current.outline, colour }))} />
            {numeric('Outline thickness', current.outline.width, defaultImageEdits.outline.width, 0, 50, value => setting('outline', { ...current.outline, width: value }))}
          </>}
          <label className="ic-inspector-check"><span>Shadow</span><input type="checkbox" checked={current.shadow.enabled}
            onChange={event => commit(setting('shadow', { ...current.shadow, enabled: event.currentTarget.checked }))} /></label>
          {current.shadow.enabled && <>
            <EffectColour label="Shadow colour" colour={current.shadow.colour} {...{ swatches }} change={colour => commit(setting('shadow', { ...current.shadow, colour }))} />
            {numeric('Shadow opacity (%)', current.shadow.opacity, defaultImageEdits.shadow.opacity, 0, 100, value => setting('shadow', { ...current.shadow, opacity: value }))}
            {numeric('Shadow offset X', current.shadow.x, defaultImageEdits.shadow.x, -100, 100, value => setting('shadow', { ...current.shadow, x: value }))}
            {numeric('Shadow offset Y', current.shadow.y, defaultImageEdits.shadow.y, -100, 100, value => setting('shadow', { ...current.shadow, y: value }))}
            {numeric('Shadow softness', current.shadow.blur, defaultImageEdits.shadow.blur, 0, 60, value => setting('shadow', { ...current.shadow, blur: value }))}
          </>}
          <button className="ic-button" type="button" onClick={() => commit({ ...current, outline: defaultImageEdits.outline, shadow: defaultImageEdits.shadow })}>Reset effects</button>
        </>}
        {id === 'colours' && <ImageColours {...{ photo, width, height, swatches, disabled }} edits={current} change={onSwatches} />}
      </fieldset>}
      </div>
    </div>)}
    <div className="ic-image-actions">
      <button type="button" className="ic-button" aria-pressed={comparing} disabled={!edits || !photo}
        onClick={() => compare(!comparing)}>Compare Original</button>
      <button type="button" className="ic-button" disabled={disabled || !edits} onClick={() => commit(undefined)}>Reset All Image Edits</button>
    </div>
    {comparing && <p className="ic-image-help" role="status">Showing the full, unedited source in its current image box.</p>}
    {cropOpen && writable && photo && <ImageCropDialog key={url} photo={photo} edits={current}
      close={() => setCropOpen(false)} apply={next => { commit(next); setCropOpen(false) }} />}
  </section>
}

function EditNumber({ label, value, neutral, min, max, step = 1, preview, commit }: {
  label: string; value: number; neutral: number; min: number; max: number; step?: number
  preview: (value: number | undefined) => void; commit: (value: number) => void
}) {
  const drag = useRef<number>(undefined)
  const cancelled = useRef(false)
  const latest = useRef<number>(undefined)
  const [active, setActive] = useState<number>()
  const [typed, setTyped] = useState<string>()
  const displayed = active ?? value

  function apply(number: number) {
    const next = Math.min(max, Math.max(min, Math.round(number / step) * step))
    if (next !== value) commit(next)
    else preview(undefined)
  }

  function cancel() {
    if (drag.current === undefined) return
    cancelled.current = true
    drag.current = undefined
    latest.current = undefined
    setActive(undefined)
    preview(undefined)
  }

  return <div className="ic-image-number">
    <label className="ic-image-number-slider"><span>{label}</span><input type="range" {...{ min, max, step }} value={displayed}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current !== undefined) return
        cancelled.current = false
        drag.current = event.pointerId
        latest.current = undefined
        event.currentTarget.setPointerCapture(event.pointerId)
      }} onPointerUp={event => {
        if (cancelled.current) { cancelled.current = false; return }
        if (drag.current !== event.pointerId) return
        drag.current = undefined
        setActive(undefined)
        apply(latest.current ?? event.currentTarget.valueAsNumber)
        latest.current = undefined
      }} onPointerCancel={cancel} onLostPointerCapture={cancel}
      onChange={event => {
        if (cancelled.current) return
        const number = event.currentTarget.valueAsNumber
        if (drag.current === undefined) apply(number)
        else { latest.current = number; setActive(number); preview(number) }
      }} onKeyDown={event => {
        if (event.key === 'Escape' && drag.current !== undefined) cancel()
        else if (event.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) cancelled.current = false
      }} /></label>
    <input type="number" aria-label={`${label} value`} {...{ min, max, step }} value={typed ?? displayed}
      onChange={event => setTyped(event.currentTarget.value)} onBlur={event => {
        if (typed !== undefined && Number.isFinite(event.currentTarget.valueAsNumber)) apply(event.currentTarget.valueAsNumber)
        setTyped(undefined)
      }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { event.preventDefault(); setTyped(undefined) }
      }} />
    <button type="button" className="ic-icon" title={`Reset ${label}`} aria-label={`Reset ${label}`} disabled={displayed === neutral}
      onClick={() => apply(neutral)}><RotateCcw /></button>
  </div>
}

function ImageLookPreview({ photo, edits, name, width, height }: { photo: HTMLImageElement; edits: ImageEdits; name: ImageEdits['look']['name']; width: number; height: number }) {
  const view = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const container = view.current
    try { container?.replaceChildren(renderEditedImage(photo, { ...edits, look: { name, intensity: 100 } }, { width, height, maxSide: 96, includeEffects: false }).canvas) }
    catch { container?.replaceChildren() }
  }, [photo, edits, name, width, height])
  return <span ref={view} className="ic-image-look-preview" aria-hidden="true" />
}

function EffectColour({ label, colour, swatches, change }: { label: string; colour: string; swatches: readonly ProjectSwatch[]; change: (colour: string) => void }) {
  return <div className="ic-image-effect-colour">
    <label><span>{label}</span><input type="color" value={colour.slice(0, 7)} onChange={event => change(event.currentTarget.value)} /></label>
    {!!swatches.length && <select aria-label={`${label} swatch`} value="" onChange={event => {
      const swatch = swatches.find(item => item.id === event.currentTarget.value)
      if (swatch) change(swatch.colour.slice(0, 7))
    }}><option value="">Use a swatch…</option>{swatches.map(swatch => <option key={swatch.id} value={swatch.id}>{swatch.name}</option>)}</select>}
  </div>
}

function readSampleHex(value: string) {
  const text = value.trim()
  return /^#[\da-f]{6}([\da-f]{2})?$/i.test(text) ? text.toLowerCase() : undefined
}

function ImageColours({ photo, edits, width, height, swatches, disabled, change }: {
  photo?: HTMLImageElement; edits: ImageEdits; width: number; height: number; swatches: readonly ProjectSwatch[]
  disabled: boolean; change: (swatches: ProjectSwatch[]) => void
}) {
  const [sampling, setSampling] = useState(false)
  const [hex, setHex] = useState('#000000')
  const [channels, setChannels] = useState(['0', '0', '0', '255'])
  const [name, setName] = useState('')
  const [status, setStatus] = useState('')
  const [probe, setProbe] = useState({ x: .5, y: .5 })
  const preview = useRef<HTMLSpanElement>(null)
  const target = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const bitmap = useRef<ReturnType<typeof renderEditedImage>>(undefined)
  const parsed = readSampleHex(hex)

  useEffect(() => {
    bitmap.current = undefined
    if (!sampling || !photo) return
    try {
      bitmap.current = renderEditedImage(photo, edits, { width, height, maxSide: 768, includeEffects: false })
      preview.current?.replaceChildren(bitmap.current.canvas)
      target.current?.focus()
    } catch (reason) { setStatus(String(reason)); preview.current?.replaceChildren() }
  }, [sampling, photo, edits, width, height])

  function setFromHex(next: string) {
    setHex(next)
    const colour = readSampleHex(next)
    if (colour) setChannels([1, 3, 5, 7].map(offset => String(parseInt(colour.slice(offset, offset + 2) || 'ff', 16))))
  }

  function setFromChannel(index: number, value: string) {
    const next = channels.map((channel, position) => position === index ? value : channel)
    setChannels(next)
    if (next.every(channel => /^\d{1,3}$/.test(channel) && Number(channel) <= 255)) {
      const values = (Number(next[3]) === 255 ? next.slice(0, 3) : next).map(channel => Number(channel).toString(16).padStart(2, '0'))
      setHex('#' + values.join(''))
    } else setHex('')
  }

  function sample(x: number, y: number) {
    if (!bitmap.current) return
    setProbe({ x, y })
    const colour = sampleRenderedImage(bitmap.current, x, y)
    if (!colour) { setStatus('That point is transparent. Try a visible pixel.'); return }
    const alpha = Math.round(colour.alpha * 255)
    const hex = colour.hex + (alpha === 255 ? '' : alpha.toString(16).padStart(2, '0'))
    setFromHex(hex)
    setStatus(`Sampled ${hex}`)
  }

  function closeSampler() {
    setSampling(false)
    setStatus('')
    trigger.current?.focus()
  }

  return <div className="ic-image-colours" onKeyDown={event => {
    if (event.key === 'Escape' && sampling) { event.preventDefault(); event.stopPropagation(); closeSampler() }
  }}>
    <button type="button" ref={trigger} className="ic-button" disabled={!photo} aria-pressed={sampling}
      onClick={() => { if (sampling) closeSampler(); else { setStatus(''); setSampling(true) } }}><Pipette />Sample colour</button>
    {sampling && <>
      <p className="ic-image-help">Choose a visible pixel. Arrow keys move the sample point, and Enter samples it.</p>
      <button type="button" ref={target} className="ic-image-sample" aria-label="Sample from edited image" onKeyDown={event => {
        const dx = event.key === 'ArrowRight' ? .025 : event.key === 'ArrowLeft' ? -.025 : 0
        const dy = event.key === 'ArrowDown' ? .025 : event.key === 'ArrowUp' ? -.025 : 0
        if (dx || dy) { event.preventDefault(); setProbe({ x: Math.min(.999, Math.max(0, probe.x + dx)), y: Math.min(.999, Math.max(0, probe.y + dy)) }) }
      }} onClick={event => {
        if (!event.detail) { sample(probe.x, probe.y); return }
        const bounds = event.currentTarget.getBoundingClientRect()
        sample((event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height)
      }}>
        <span ref={preview} aria-hidden="true" /><span className="ic-image-sample-point" aria-hidden="true" style={{ left: `${probe.x * 100}%`, top: `${probe.y * 100}%` }} />
      </button>
    </>}
    {status && <p className="ic-image-help" role="status">{status}</p>}
    <div className="ic-image-sample-hex">
      <span aria-hidden="true" style={{ background: parsed ?? 'transparent' }} />
      <label className="ic-inspector-field"><span>HEX</span><input spellCheck={false} value={hex} maxLength={9} aria-invalid={!parsed}
        onChange={event => setFromHex(event.currentTarget.value)} /></label>
    </div>
    <div className="ic-image-sample-rgba">
      {['Red', 'Green', 'Blue', 'Alpha'].map((label, index) => <label className="ic-inspector-field" key={label}><span>{label}</span>
        <input type="number" min="0" max="255" value={channels[index]} onChange={event => setFromChannel(index, event.currentTarget.value)} /></label>)}
    </div>
    <label className="ic-inspector-field"><span>Swatch name</span><input maxLength={maxSwatchNameLength} value={name} onChange={event => setName(event.currentTarget.value)} /></label>
    <button type="button" className="ic-button" disabled={disabled || !parsed || swatches.length >= maxProjectSwatches} onClick={() => {
      if (!parsed || disabled) return
      const label = name.trim() || parsed.toUpperCase()
      change([...swatches, { id: crypto.randomUUID(), name: label, colour: parsed }])
      setStatus(`Added ${label}`)
      setName('')
    }}>Add swatch</button>
    {!!swatches.length && <ul className="ic-image-swatches" aria-label="Project swatches">
      {swatches.map(swatch => <li key={swatch.id}>
        <button type="button" className="ic-inspector-swatch" style={{ background: swatch.colour }}
          title={`Use ${swatch.name}`} aria-label={`Use ${swatch.name}`} onClick={() => setFromHex(swatch.colour)} />
        <input key={`${swatch.id}-${swatch.name}`} aria-label={`Rename ${swatch.name}`} defaultValue={swatch.name} disabled={disabled}
          maxLength={maxSwatchNameLength} onBlur={event => {
            const next = event.currentTarget.value.trim()
            if (!next) event.currentTarget.value = swatch.name
            else if (next !== swatch.name) change(swatches.map(item => item.id === swatch.id ? { ...item, name: next } : item))
          }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
        <button type="button" className="ic-inspector-icon" aria-label={`Remove ${swatch.name}`} title={`Remove ${swatch.name}`} disabled={disabled}
          onClick={() => change(swatches.filter(item => item.id !== swatch.id))}><Trash2 /></button>
      </li>)}
    </ul>}
  </div>
}
