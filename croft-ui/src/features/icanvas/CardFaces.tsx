import { useRef } from 'react'
import { RotateCcw } from 'lucide-react'
import { type CanvasObject, canFlip, cardFace, cardSide } from './model'
import { CanvasDialog } from './ProjectViews'
import './card-faces.css'

export function CardFlipControl({ object, flipCard }: {
  object: CanvasObject; flipCard: (object: CanvasObject) => void
}) {
  const pointer = useRef<string>(undefined)
  if (!canFlip(object)) return null

  const next = cardSide(object) === 'back' ? 'front' : 'back'
  const label = `Show ${next} of card`
  return <button type="button" className="ic-card-flip" aria-label={label} title="Double-click to flip" data-media-control
    onPointerDown={event => { pointer.current = event.pointerType; event.stopPropagation() }}
    onPointerCancel={() => { pointer.current = undefined }}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
    onClick={event => {
      event.stopPropagation()
      if (event.detail === 0 || pointer.current === 'touch') flipCard(object)
    }}
    onDoubleClick={event => {
      event.stopPropagation()
      if (pointer.current !== 'touch') flipCard(object)
    }}>
    <RotateCcw aria-hidden="true" />
  </button>
}

export function CardBackEditor({ object, close, save }: {
  object: CanvasObject; close: () => void; save: (face: { title: string; text: string }) => void
}) {
  const back = cardFace(object, 'back')
  return <CanvasDialog title="Edit card back" close={close}>
    <form className="ic-form" onSubmit={event => {
      event.preventDefault()
      const values = new FormData(event.currentTarget)
      save({ title: String(values.get('title') ?? '').trim(), text: String(values.get('text') ?? '') })
    }}>
      <label>Back title<input name="title" autoFocus maxLength={240} defaultValue={back.title} /></label>
      <label>Back text<textarea name="text" rows={5} maxLength={20_000} defaultValue={back.text} /></label>
      <div className="ic-dialog-actions">
        <button type="button" className="ic-button" onClick={close}>Cancel</button>
        <button className="ic-button ic-primary">Apply</button>
      </div>
    </form>
  </CanvasDialog>
}
