import { Plus } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { readHexColour, readRGBChannels, toHexColour, toHSV, toRGB, type HSV, type RGB } from './colour'
import { palette, type ProjectSwatch } from './model'

function editableColour(colour: string) {
  // Existing packages may use CSS hex with alpha. The separate opacity control remains available.
  if (/^#[\da-f]{4}$/i.test(colour)) return colour.slice(0, 4)
  if (/^#[\da-f]{8}$/i.test(colour)) return colour.slice(0, 7)
  return colour
}

export function ColourPicker({ colour, onChange, swatches }: {
  colour: string; onChange: (colour: string) => void; swatches?: readonly ProjectSwatch[]
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const preset = palette.includes(colour)

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  return <div className="ic-colour-control" onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); close() }
    event.stopPropagation()
  }}>
    <div className="ic-inspector-palette">
      {palette.map(swatch => <button key={swatch} type="button" className="ic-inspector-swatch"
        style={{ backgroundColor: swatch }} aria-label={'Select colour ' + swatch} title={'Select colour ' + swatch}
        aria-pressed={colour === swatch} onClick={() => { onChange(swatch); setOpen(false) }} />)}
      <button type="button" ref={trigger} className="ic-colour-custom" data-custom={!preset}
        style={{ '--ic-custom-colour': colour } as CSSProperties} aria-label="Custom colour" title="Custom colour"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
        {preset ? <Plus aria-hidden="true" /> : <span aria-hidden="true" />}
      </button>
    </div>
    {!!swatches?.length && <div role="group" aria-label="Project swatches" className="ic-inspector-palette">
      {swatches.map(swatch => <button key={swatch.id} type="button" className="ic-inspector-swatch"
        style={{ backgroundColor: swatch.colour }} aria-label={'Use swatch ' + swatch.name} title={swatch.name}
        aria-pressed={colour === swatch.colour} onClick={() => { onChange(swatch.colour); setOpen(false) }} />)}
    </div>}
    {open && <ColourInputs id={id} original={colour} close={close} apply={onChange} />}
  </div>
}

const channels = ['Red', 'Green', 'Blue'] as const
const sliders = [{ label: 'Hue', key: 'hue', max: 359 }, { label: 'Saturation', key: 'saturation', max: 100 },
  { label: 'Brightness', key: 'brightness', max: 100 }] as const

function ColourInputs({ id, original, close, apply }: { id: string; original: string; close: () => void; apply: (colour: string) => void }) {
  const [hsv, setHSV] = useState(() => toHSV(readHexColour(editableColour(original)) ?? [0, 0, 0]))
  const [hex, setHex] = useState(() => toHexColour(toRGB(hsv)))
  const [rgb, setRGB] = useState(() => toRGB(hsv).map(String))
  const panel = useRef<HTMLDivElement>(null)
  const parsedHex = readHexColour(hex)
  const parsedRGB = readRGBChannels(rgb)
  const error = !parsedHex ? 'Enter a 3- or 6-digit HEX colour.' : !parsedRGB ? 'Enter whole RGB values from 0 to 255.' : ''

  useEffect(() => { panel.current?.scrollIntoView({ block: 'nearest' }) }, [])

  function choose(next: HSV) {
    const values = toRGB(next)
    setHSV(next)
    setHex(toHexColour(values))
    setRGB(values.map(String))
  }

  function setFromHex(next: string) {
    setHex(next)
    const parsed = readHexColour(next)
    if (!parsed) return
    setRGB(parsed.map(String))
    setHSV(toHSV(parsed, hsv.hue))
  }

  function setFromChannel(index: number, value: string) {
    const next = rgb.map((channel, position) => position === index ? value : channel)
    setRGB(next)
    const parsed = readRGBChannels(next)
    if (!parsed) return
    setHex(toHexColour(parsed))
    setHSV(toHSV(parsed, hsv.hue))
  }

  function pickFromWheel(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width * 2 - 1
    const y = (event.clientY - rect.top) / rect.height * 2 - 1
    const saturation = Math.min(1, Math.hypot(x, y))
    const hue = saturation ? (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 : hsv.hue
    choose({ hue, saturation, brightness: hsv.brightness || 1 })
  }

  function applyColour() {
    if (!parsedHex || !parsedRGB) return
    const chosen = toHexColour(parsedHex)
    const originalRGB = readHexColour(editableColour(original))
    if (!originalRGB || chosen !== toHexColour(originalRGB)) apply(chosen)
    close()
  }

  const angle = hsv.hue * Math.PI / 180
  const wheelStyle = { '--ic-wheel-darkness': 1 - hsv.brightness,
    '--ic-wheel-x': `${50 + 50 * hsv.saturation * Math.cos(angle)}%`,
    '--ic-wheel-y': `${50 + 50 * hsv.saturation * Math.sin(angle)}%`, '--ic-wheel-colour': toHexColour(toRGB(hsv)) } as CSSProperties

  return <div id={id} ref={panel} className="ic-colour-picker" onKeyDown={event => {
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'range') {
      event.preventDefault()
      applyColour()
    }
  }}>
    <div className="ic-colour-wheel-group" role="group" aria-label="Colour wheel">
      <div className="ic-colour-wheel" data-colour-wheel="" aria-hidden="true" style={wheelStyle}
        onPointerDown={event => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          pickFromWheel(event)
        }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pickFromWheel(event) }}>
        <span />
      </div>
      <div className="ic-colour-sliders">
        {sliders.map(({ label, key, max }) => <label key={key}>
          <span>{label}</span><input type="range" min="0" max={max} value={key === 'hue' ? Math.min(max, Math.round(hsv.hue)) : Math.round(hsv[key] * 100)}
            onChange={event => choose({ ...hsv, [key]: event.currentTarget.valueAsNumber / (key === 'hue' ? 1 : 100) })} />
        </label>)}
      </div>
    </div>
    <div className="ic-colour-hex">
      <span className="ic-colour-preview" aria-hidden="true" style={{ backgroundColor: toHexColour(toRGB(hsv)) }} />
      <label className="ic-inspector-field"><span>HEX</span><input type="text" spellCheck={false} autoComplete="off"
        maxLength={10} value={hex} aria-invalid={!parsedHex} onChange={event => setFromHex(event.currentTarget.value)} /></label>
    </div>
    <div className="ic-colour-rgb">
      {channels.map((name, index) => <label className="ic-inspector-field" key={name}><span>{name}</span>
        <input type="number" min="0" max="255" step="1" value={rgb[index]} aria-invalid={!/^\d{1,3}$/.test(rgb[index]) || Number(rgb[index]) > 255}
          onChange={event => setFromChannel(index, event.currentTarget.value)} />
      </label>)}
    </div>
    {error && <p className="ic-colour-error" role="status">{error}</p>}
    <div className="ic-colour-actions">
      <button type="button" className="ic-button" onClick={close}>Cancel</button>
      <button type="button" className="ic-button ic-primary" disabled={!!error} onClick={applyColour}>Apply colour</button>
    </div>
  </div>
}
