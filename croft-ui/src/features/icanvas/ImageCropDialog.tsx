import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { ImageEdits } from './imageEdits'
import { renderCropSource } from './imageRendering'
import { fitCrop, fullCrop, isFullCrop, moveCrop, type CropArea, type CropHandle } from './imageCrop'
import { CanvasDialog } from './ProjectViews'

const ratios = { free: 0, original: 0, '1:1': 1, '4:3': 4 / 3, '16:9': 16 / 9 }
type Ratio = keyof typeof ratios
const handles = [
  { name: 'Top left crop handle', side: 'north-west' }, { name: 'Top right crop handle', side: 'north-east' },
  { name: 'Bottom left crop handle', side: 'south-west' }, { name: 'Bottom right crop handle', side: 'south-east' },
] as const

export function ImageCropDialog({ photo, edits, close, apply }: {
  photo: HTMLImageElement; edits: ImageEdits; close: () => void; apply: (edits: ImageEdits) => void
}) {
  const source = { width: photo.naturalWidth, height: photo.naturalHeight }
  const sourceAspect = source.width / source.height
  const changedSource = !!edits.crop && !!edits.source && (edits.source.width !== source.width || edits.source.height !== source.height)
  const [rect, setRect] = useState(changedSource ? fullCrop : edits.crop ?? fullCrop)
  const [angle, setAngle] = useState(edits.straighten)
  const [angleInput, setAngleInput] = useState<string>()
  const [ratio, setRatio] = useState<Ratio>('free')
  const [portrait, setPortrait] = useState(sourceAspect < 1)
  const stage = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; handle: CropHandle; start: CropArea; x: number; y: number }>(undefined)

  useEffect(() => {
    const view = preview.current
    view?.replaceChildren(renderCropSource(photo, angle))
  }, [photo, angle])

  function normalizedRatio(next: Ratio, vertical: boolean) {
    if (next === 'free') return undefined
    if (next === 'original') return 1
    return (vertical ? 1 / ratios[next] : ratios[next]) / sourceAspect
  }

  function changeRatio(next: Ratio, vertical: boolean) {
    const aspect = normalizedRatio(next, vertical)
    setRatio(next)
    setPortrait(vertical)
    setRect(current => fitCrop(current, aspect))
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, handle: CropHandle) {
    if (event.button !== 0 || drag.current) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, handle, start: rect, x: event.clientX, y: event.clientY }
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current
    const box = stage.current?.getBoundingClientRect()
    if (!active || active.id !== event.pointerId || !box?.width || !box.height) return
    setRect(moveCrop(active.start, active.handle, (event.clientX - active.x) / box.width,
      (event.clientY - active.y) / box.height, normalizedRatio(ratio, portrait)))
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, cancel = false) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    if (cancel) setRect(active.start)
    drag.current = undefined
  }

  function arrowKeys(event: React.KeyboardEvent<HTMLButtonElement>, handle: CropHandle) {
    const amount = event.shiftKey ? .05 : .01
    const x = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
    const y = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0
    if (!x && !y) return
    event.preventDefault()
    setRect(current => moveCrop(current, handle, x, y, normalizedRatio(ratio, portrait)))
  }

  function commit() {
    const crop = isFullCrop(rect) ? undefined : rect
    const typed = Number(angleInput)
    const straighten = angleInput?.trim() && Number.isFinite(typed) ? Math.max(-45, Math.min(45, typed)) : angle
    apply({ ...edits, crop, source: crop ? source : undefined, straighten })
  }

  const selectionStyle = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }

  return <CanvasDialog title="Crop & Straighten" close={close}>
    <form className="ic-form ic-image-crop-form" onSubmit={event => { event.preventDefault(); commit() }} onKeyDown={event => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.target instanceof HTMLInputElement && event.target.type === 'number' && !event.target.validity.valid) return
      if (!(event.target instanceof HTMLButtonElement) || event.target.dataset.cropHandle) {
        event.preventDefault()
        commit()
      }
    }}>
      {changedSource && <p className="ic-error" role="status">The source dimensions changed. Apply a new crop to this image or relink the original.</p>}
      <div className="ic-image-crop-stage" ref={stage} style={{ aspectRatio: sourceAspect, maxWidth: Math.min(440, sourceAspect * 320) }}
        role="group" aria-label="Full source crop view" onPointerMove={moveDrag} onPointerUp={finishDrag}
        onPointerCancel={event => finishDrag(event, true)} onLostPointerCapture={event => finishDrag(event, true)}>
        <div className="ic-image-crop-source" aria-hidden="true">
          <div ref={preview} className="ic-image-crop-pixels" />
          <span className="ic-image-crop-shade" style={selectionStyle} />
        </div>
        <div className="ic-image-crop-selection" style={selectionStyle}>
          <button type="button" className="ic-image-crop-move" data-crop-handle="move" aria-label="Move crop selection"
            onPointerDown={event => startDrag(event, 'move')} onKeyDown={event => arrowKeys(event, 'move')} />
          {handles.map(({ name, side }) => <button key={side} type="button" className="ic-image-crop-corner" data-crop-handle={side} aria-label={name}
            onPointerDown={event => startDrag(event, side)} onKeyDown={event => arrowKeys(event, side)} />)}
        </div>
      </div>
      <p className="ic-image-help">Drag a corner to crop. Arrow keys adjust the focused handle. Any uncovered corners stay transparent.</p>
      <div className="ic-image-crop-settings">
        <label>Crop aspect ratio<select value={ratio} onChange={event => changeRatio(event.currentTarget.value as Ratio, portrait)}>
          <option value="free">Free</option><option value="original">Original</option><option value="1:1">1:1</option>
          <option value="4:3">4:3</option><option value="16:9">16:9</option>
        </select></label>
        <label>Aspect orientation<select value={portrait ? 'portrait' : 'landscape'} disabled={ratio !== '4:3' && ratio !== '16:9'}
          onChange={event => changeRatio(ratio, event.currentTarget.value === 'portrait')}>
          <option value="landscape">Landscape</option><option value="portrait">Portrait</option>
        </select></label>
      </div>
      <div className="ic-image-crop-angle">
        <label>Straighten<input type="range" min={-45} max={45} step={.1} value={angle} onChange={event => setAngle(event.currentTarget.valueAsNumber)} /></label>
        <label>Angle (°)<input type="number" min={-45} max={45} step={.1} value={angleInput ?? angle} onChange={event => setAngleInput(event.currentTarget.value)}
          onBlur={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) setAngle(Math.max(-45, Math.min(45, value)))
            setAngleInput(undefined)
          }} /></label>
        <button type="button" className="ic-button" onClick={() => setAngle(0)}>Reset angle</button>
      </div>
      <div className="ic-dialog-actions">
        <button type="button" className="ic-button ic-image-crop-reset" onClick={() => { setRect(fullCrop); setRatio('free') }}>Reset crop</button>
        <button type="button" className="ic-button" onClick={close}>Cancel</button><button type="submit" className="ic-button ic-primary">Apply Crop</button>
      </div>
    </form>
  </CanvasDialog>
}
