import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ColourPicker } from './ColourPicker'
import { providerLabel, type SmartlinkContent, type SmartlinkMode } from './smartlinks'
import {
  ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, ChevronDown, ChevronRight,
  Eye, EyeOff, Layers, Lock, PanelLeft, PanelRight, SlidersHorizontal, Unlock, X,
} from 'lucide-react'
import {
  canFlip, cardSide, colourForEdge, inspectorWidth, kinds, objectFlags,
  type CanvasEdge, type CanvasObject, type CanvasProject, type CanvasSettings, type ProjectSwatch,
} from './model'
import './inspector.css'

type LayerDirection = 'front' | 'back' | 'forward' | 'backward'
type UpdateObject = (object: CanvasObject, patch: Partial<CanvasObject>) => void
type CardActions = {
  flipCard?: (object: CanvasObject) => void
  editBack?: (object: CanvasObject) => void
  attachBack?: (object: CanvasObject) => void
  removeBackAttachment?: (object: CanvasObject) => void
  selectStackMember?: (stack: CanvasObject, member: CanvasObject) => void
  removeFromStack?: (member: CanvasObject) => void
  setStackFanned?: (stack: CanvasObject, fanned: boolean) => void
  unstack?: (stack: CanvasObject) => void
  deleteStack?: (stack: CanvasObject) => void
  editSmartlink?: (object: CanvasObject, side: 'front' | 'back') => void
  updateSmartlink?: (object: CanvasObject, side: 'front' | 'back', patch: Partial<SmartlinkContent>) => void
  removeSmartlink?: (object: CanvasObject, side: 'front' | 'back') => void
}

interface InspectorProps extends CardActions {
  project: CanvasProject
  stageWidth: number
  selected: CanvasObject[]
  activeEdge?: CanvasEdge
  select: (id: string) => void
  update: UpdateObject
  updateEdge: (edge: CanvasEdge, patch: Partial<CanvasEdge>) => void
  reorder: (id: string, direction: LayerDirection) => void
  moveIntoFrame: (object: CanvasObject, frameId: string) => void
  fitFrame: (object: CanvasObject) => void
  settings: (patch: Partial<CanvasSettings>) => void
  mediaTools?: ReactNode
}

function ResizableInspector({ children, panelId, stageWidth, settings, onResize }: {
  children: ReactNode; panelId: string; stageWidth: number; settings: CanvasSettings; onResize: (width: number) => void
}) {
  const [draft, setDraft] = useState<number>()
  const drag = useRef<{ id: number; startX: number; startWidth: number } | undefined>(undefined)
  const side = settings.inspectorSide ?? 'right'
  const parked = settings.toolbar === 'parked'
  const outward = side === 'left' ? 1 : -1
  // Match the parked-toolbar offset and leave canvas space at the moving edge.
  const inset = parked && side === 'left' ? 60 : 12
  const max = stageWidth ? Math.max(1, Math.min(inspectorWidth.max, Math.floor(stageWidth - inset - 64))) : inspectorWidth.max
  const min = Math.min(inspectorWidth.min, max)
  const clamp = (width: number) => Math.max(min, Math.min(max, Math.round(width)))
  const width = clamp(draft ?? settings.inspectorWidth ?? inspectorWidth.default)

  function endDrag(handle: HTMLElement, id: number) {
    drag.current = undefined
    setDraft(undefined)
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id)
  }

  return <div className="ic-inspector-shell" data-side={side} data-toolbar-parked={parked}
    data-minimap={settings.minimap} data-card-scroll style={{ width }} onPointerDown={event => event.stopPropagation()}>
    {children}
    {(min < max || draft !== undefined) && <div className="ic-inspector-resize" role="separator" aria-orientation="vertical" aria-label="Resize inspector"
      aria-controls={panelId} aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`}
      title="Drag to resize. Double-click to reset width." tabIndex={0} data-resizing={draft !== undefined}
      onDoubleClick={event => {
        event.stopPropagation()
        if (settings.inspectorWidth !== undefined && settings.inspectorWidth !== inspectorWidth.default) {
          onResize(inspectorWidth.default)
        }
      }}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width }
        setDraft(width)
      }}
      onPointerMove={event => {
        const active = drag.current
        if (active?.id === event.pointerId) setDraft(clamp(active.startWidth + (event.clientX - active.startX) * outward))
      }}
      onPointerUp={event => {
        const active = drag.current
        if (active?.id !== event.pointerId) return
        const next = clamp(active.startWidth + (event.clientX - active.startX) * outward)
        endDrag(event.currentTarget, event.pointerId)
        if (next >= inspectorWidth.min && next !== active.startWidth) onResize(next)
      }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) endDrag(event.currentTarget, event.pointerId) }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) endDrag(event.currentTarget, event.pointerId) }}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (drag.current) {
          if (event.key === 'Escape') endDrag(event.currentTarget, drag.current.id)
          event.preventDefault()
          event.stopPropagation()
          return
        }
        const delta = event.key === 'ArrowLeft' ? -10 : event.key === 'ArrowRight' ? 10 : 0
        const next = event.key === 'Home' ? min : event.key === 'End' ? max : delta ? clamp(width + delta * outward) : undefined
        if (next === undefined) return
        event.preventDefault()
        event.stopPropagation()
        if (next !== width) onResize(next)
      }} />}
  </div>
}

function NumberField({ label, value, onCommit, min, max }: {
  label: string; value: number; onCommit: (value: number) => void; min?: number; max?: number
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const displayed = String(Math.round(value * 1000) / 1000)
  return <label className="ic-inspector-field">
    <span>{label}</span>
    <input type="number" value={draft ?? displayed} min={min} max={max} step="any"
      onChange={event => setDraft(event.currentTarget.value)}
      onBlur={event => {
        const next = event.currentTarget.valueAsNumber
        if (draft !== null && Number.isFinite(next)) {
          const bounded = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, next))
          if (bounded !== value) onCommit(bounded)
        }
        setDraft(null)
      }}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          setDraft(null)
          return
        }
        event.currentTarget.blur()
      }}
    />
  </label>
}

function TextField({ label, value, onCommit, multiline = false, required = false }: {
  label: string; value: string; onCommit: (value: string) => void; multiline?: boolean; required?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null) {
      const next = required ? draft.trim() : draft
      if ((!required || next) && next !== value) onCommit(next)
    }
    setDraft(null)
  }
  const props = {
    value: draft ?? value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.currentTarget.value),
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        setDraft(null)
      } else if (event.key === 'Enter' && !multiline) {
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.blur()
      }
    },
  }
  return <label className="ic-inspector-field">
    <span>{label}</span>
    {multiline ? <textarea {...props} rows={3} /> : <input type="text" {...props} required={required} />}
  </label>
}

function ObjectProperties({ object, objects, update, reorder, moveIntoFrame, fitFrame, flipCard, editBack, attachBack,
  removeBackAttachment, selectStackMember, removeFromStack, setStackFanned, unstack, deleteStack, editSmartlink, updateSmartlink, removeSmartlink, mediaTools, swatches }: CardActions & {
  object: CanvasObject
  objects: ReadonlyMap<string, CanvasObject>
  update: UpdateObject
  reorder: InspectorProps['reorder']
  moveIntoFrame: InspectorProps['moveIntoFrame']
  fitFrame: InspectorProps['fitFrame']
  mediaTools?: ReactNode
  swatches?: ProjectSwatch[]
}) {
  const parent = object.parentId ? objects.get(object.parentId) : undefined
  const parentLocked = parent ? objectFlags(parent, objects).locked : false
  const locked = object.locked || parentLocked
  const frame = object.kind === 'frame'
  const stack = object.stack
  const side = cardSide(object)
  const sideSmartlink = side === 'back' ? object.back?.smartlink : object.smartlink
  const hasContent = object.kind === 'text' || object.kind === 'note'
  const frames = Array.from(objects.values()).filter(candidate => {
    if (candidate.kind !== 'frame' || candidate.id === object.id) return false
    if (candidate.id === parent?.id) return true
    const flags = objectFlags(candidate, objects)
    if (flags.hidden || flags.locked || candidate.collapsed) return false
    let ancestor = candidate.parentId ? objects.get(candidate.parentId) : undefined
    const visited = new Set([candidate.id])
    while (ancestor) {
      if (ancestor.id === object.id || visited.has(ancestor.id)) return false
      visited.add(ancestor.id)
      ancestor = ancestor.parentId ? objects.get(ancestor.parentId) : undefined
    }
    return true
  })
  const updateNumber = (property: 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity') =>
    (value: number) => update(object, { [property]: value })

  return <>
    <div className="ic-inspector-summary">
      <div>
        <h3>{object.name}</h3>
        <p>{kinds[object.kind]}</p>
      </div>
      <button type="button" className="ic-inspector-icon" title={object.hidden ? 'Show object' : 'Hide object'}
        aria-label={object.hidden ? 'Show object' : 'Hide object'} aria-pressed={object.hidden} disabled={locked}
        onClick={() => update(object, { hidden: !object.hidden })}>
        {object.hidden ? <EyeOff /> : <Eye />}
      </button>
      <button type="button" className="ic-inspector-icon" title={object.locked ? 'Unlock object' : 'Lock object'}
        aria-label={object.locked ? 'Unlock object' : 'Lock object'} aria-pressed={object.locked} disabled={parentLocked}
        onClick={() => update(object, { locked: !object.locked })}>
        {locked ? <Lock /> : <Unlock />}
      </button>
    </div>
    {parentLocked && <p className="ic-inspector-status">Locked by a parent layer.</p>}
    {mediaTools}
    <fieldset className="ic-inspector-section" disabled={locked}>
      <legend>Smartlink</legend>
      {sideSmartlink ? <>
        <p className="ic-colour-hint">{providerLabel(sideSmartlink.provider)} · {sideSmartlink.canonicalUrl}</p>
        <label className="ic-inspector-field"><span>Display mode</span>
          <select value={sideSmartlink.mode} onChange={event => updateSmartlink?.(object, side, { mode: event.currentTarget.value as SmartlinkMode })}>
            <option value="embed" disabled={sideSmartlink.provider === 'website'}>Embed</option><option value="preview">Preview Card</option><option value="link">Link Only</option>
          </select>
        </label>
        <TextField label="Link title" value={sideSmartlink.title ?? ''} onCommit={title => updateSmartlink?.(object, side, { title })} />
        <TextField label="Link notes" value={sideSmartlink.notes ?? ''} multiline onCommit={notes => updateSmartlink?.(object, side, { notes })} />
        <div className="ic-inspector-card-actions">
          {editSmartlink && <button type="button" className="ic-button" onClick={() => editSmartlink(object, side)}>Edit URL…</button>}
          {removeSmartlink && <button type="button" className="ic-button" onClick={() => removeSmartlink(object, side)}>Remove Smartlink</button>}
        </div>
      </> : <>
        <p className="ic-colour-hint">Add one link to the {side} face. It is stored separately from media on the other face.</p>
        {editSmartlink && <button type="button" className="ic-button" onClick={() => editSmartlink(object, side)}>Add Smartlink…</button>}
      </>}
    </fieldset>
    {canFlip(object) && (flipCard || editBack) && <fieldset className="ic-inspector-section">
      <legend>Card faces</legend>
      <p className="ic-colour-hint">Showing {side === 'back' ? 'Back' : 'Front'}</p>
      <div className="ic-inspector-card-actions">
        {flipCard && <button type="button" className="ic-button" onClick={() => flipCard(object)}>
          {side === 'back' ? 'Show Front' : 'Show Back'}
        </button>}
        {editBack && <button type="button" className="ic-button" disabled={locked} onClick={() => editBack(object)}>Edit Back</button>}
        {attachBack && <button type="button" className="ic-button" disabled={locked} onClick={() => attachBack(object)}>
          {object.back?.smartlink ? 'Replace Back content…' : object.back?.assetId ? 'Replace Back attachment' : 'Add Back attachment'}
        </button>}
        {object.back?.assetId && removeBackAttachment && <button type="button" className="ic-button" disabled={locked}
          onClick={() => removeBackAttachment(object)}>Remove Back attachment</button>}
      </div>
    </fieldset>}
    {stack && <fieldset className="ic-inspector-section">
      <legend>Stack members</legend>
      <ol className="ic-inspector-stack-members">
        {stack.order.map(id => {
          const member = objects.get(id)
          if (!member || !selectStackMember) return null
          return <li key={id}><button type="button" className="ic-button" onClick={() => selectStackMember(object, member)}>{member.name}</button></li>
        })}
      </ol>
      <div className="ic-inspector-card-actions">
        {setStackFanned && <button type="button" className="ic-button" disabled={locked}
          onClick={() => setStackFanned(object, stack.layout === 'compact')}>{stack.layout === 'compact' ? 'Fan Out' : 'Restack'}</button>}
        {unstack && <button type="button" className="ic-button" disabled={locked} onClick={() => unstack(object)}>Unstack All</button>}
        {deleteStack && <button type="button" className="ic-button" disabled={locked} onClick={() => deleteStack(object)}>Delete stack…</button>}
      </div>
    </fieldset>}
    {parent?.kind === 'stack' && removeFromStack && <fieldset className="ic-inspector-section" disabled={locked}>
      <legend>{parent.name}</legend>
      <button type="button" className="ic-button" onClick={() => removeFromStack(object)}>Remove from Stack</button>
    </fieldset>}
    <fieldset className="ic-inspector-section" disabled={locked}>
      <legend>Details</legend>
      <TextField label="Name" value={object.name} required onCommit={name => update(object, { name })} />
      {hasContent && <TextField label="Content" value={object.text} multiline onCommit={text => update(object, { text })} />}
      {!stack && <><TextField label="Caption" value={object.caption ?? ''} onCommit={caption => update(object, { caption })} />
      <label className="ic-inspector-field">
        <span>Display</span>
        <select value={object.mode} onChange={event => update(object, { mode: event.currentTarget.value === 'card' ? 'card' : 'direct' })}>
          <option value="direct" disabled={parent?.kind === 'stack' && object.kind !== 'note'}>Direct</option>
          <option value="card">Card</option>
        </select>
      </label>
      {!canFlip(object) && object.back && <p className="ic-colour-hint">Switch to Card to show the saved back.</p>}
      </>}
      {parent?.kind !== 'stack' && (frames.length > 0 || parent) && <label className="ic-inspector-field">
        <span>Container</span>
        <select value={parent?.id ?? ''} onChange={event => moveIntoFrame(object, event.currentTarget.value)}>
          <option value="">Canvas</option>
          {parent?.kind === 'group' && <option value={parent.id}>{parent.name} (group)</option>}
          {frames.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
      </label>}
    </fieldset>
    <fieldset className="ic-inspector-section" disabled={locked}>
      <legend>Transform</legend>
      <div className="ic-inspector-numbers">
        <NumberField label="X" value={object.x} onCommit={updateNumber('x')} />
        <NumberField label="Y" value={object.y} onCommit={updateNumber('y')} />
        <NumberField label="Width" value={object.width} min={1} onCommit={updateNumber('width')} />
        <NumberField label="Height" value={object.height} min={1} onCommit={updateNumber('height')} />
        <NumberField label="Rotation (°)" value={object.rotation} onCommit={updateNumber('rotation')} />
        <NumberField label="Opacity (%)" value={object.opacity * 100} min={0} max={100}
          onCommit={value => updateNumber('opacity')(value / 100)} />
      </div>
      {frame && <button type="button" className="ic-button" disabled={object.collapsed || !Array.from(objects.values()).some(item => item.parentId === object.id)}
        onClick={() => fitFrame(object)}>Fit frame to contents</button>}
    </fieldset>
    <fieldset className="ic-inspector-section" disabled={locked}>
      <legend>Appearance</legend>
      {object.kind === 'text' && object.mode === 'direct'
        ? <ColourPicker colour={object.textColour ?? '#263029'} swatches={swatches} onChange={textColour => update(object, { textColour })} />
        : <ColourPicker colour={object.colour} swatches={swatches} onChange={colour => update(object, { colour })} />}
      {object.kind === 'image' && object.mode === 'direct' && <p className="ic-colour-hint">Show border uses this colour around the image.</p>}
      <label className="ic-inspector-check">
        <span>Show border</span>
        <input type="checkbox" checked={object.border ?? frame} onChange={event => update(object, { border: event.currentTarget.checked })} />
      </label>
      {frame && <label className="ic-inspector-check">
        <span>Collapse frame</span>
        <input type="checkbox" checked={!!object.collapsed} onChange={event => update(object, { collapsed: event.currentTarget.checked })} />
      </label>}
    </fieldset>
    <fieldset className="ic-inspector-section" disabled={locked}>
      <legend>Layer order</legend>
      <div className="ic-inspector-order">
        <button type="button" aria-label="Bring to front" title="Bring to front" onClick={() => reorder(object.id, 'front')}><ArrowUpToLine /></button>
        <button type="button" aria-label="Bring forward" title="Bring forward" onClick={() => reorder(object.id, 'forward')}><ArrowUp /></button>
        <button type="button" aria-label="Send backward" title="Send backward" onClick={() => reorder(object.id, 'backward')}><ArrowDown /></button>
        <button type="button" aria-label="Send to back" title="Send to back" onClick={() => reorder(object.id, 'back')}><ArrowDownToLine /></button>
      </div>
    </fieldset>
  </>
}

function ObjectLayers({ objects, selected, select, update }: {
  objects: CanvasObject[]
  selected: CanvasObject[]
  select: InspectorProps['select']
  update: UpdateObject
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const { byId, byParent } = useMemo(() => {
    const byId = new Map(objects.map(object => [object.id, object]))
    const byParent = new Map<string | undefined, CanvasObject[]>()
    for (const object of [...objects].reverse()) {
      const parentId = object.parentId && byId.has(object.parentId) ? object.parentId : undefined
      const siblings = byParent.get(parentId) ?? []
      siblings.push(object)
      byParent.set(parentId, siblings)
    }
    for (const object of objects) {
      if (!object.stack) continue
      const members = new Map(byParent.get(object.id)?.map(member => [member.id, member]))
      byParent.set(object.id, object.stack.order.flatMap(id => {
        const member = members.get(id)
        return member ? [member] : []
      }))
    }
    return { byId, byParent }
  }, [objects])
  const selectedIds = new Set(selected.map(object => object.id))

  function layers(parentId?: string) {
    return <ul className="ic-inspector-layers" aria-label={parentId ? undefined : 'Canvas layers'}>
      {byParent.get(parentId)?.map(object => {
        const hasChildren = byParent.has(object.id)
        const expanded = !closed.has(object.id)
        const flags = objectFlags(object, byId)
        const parent = object.parentId ? byId.get(object.parentId) : undefined
        const parentLocked = parent ? objectFlags(parent, byId).locked : false
        const parentHidden = parent ? objectFlags(parent, byId).hidden || !!parent.collapsed : false
        return <li key={object.id}>
          <div className="ic-inspector-layer-row" data-hidden={flags.hidden}>
            {hasChildren ? <button type="button" className="ic-inspector-icon" aria-expanded={expanded}
              aria-label={(expanded ? 'Collapse ' : 'Expand ') + object.name + ' layers'}
              onClick={() => setClosed(current => {
                const next = new Set(current)
                if (expanded) next.add(object.id)
                else next.delete(object.id)
                return next
              })}>{expanded ? <ChevronDown /> : <ChevronRight />}</button> : <span className="ic-inspector-layer-spacer" />}
            <button type="button" className="ic-inspector-layer-name" aria-pressed={selectedIds.has(object.id)}
              onClick={() => select(object.id)} title={object.name}>{object.name}</button>
            <button type="button" className="ic-inspector-icon" aria-label={(object.hidden ? 'Show ' : 'Hide ') + object.name}
              title={object.hidden ? 'Show layer' : 'Hide layer'} disabled={flags.locked || parentHidden}
              aria-pressed={flags.hidden} onClick={() => update(object, { hidden: !object.hidden })}>
              {flags.hidden ? <EyeOff /> : <Eye />}
            </button>
            <button type="button" className="ic-inspector-icon" aria-label={(object.locked ? 'Unlock ' : 'Lock ') + object.name}
              title={object.locked ? 'Unlock layer' : 'Lock layer'} disabled={parentLocked}
              aria-pressed={flags.locked} onClick={() => update(object, { locked: !object.locked })}>
              {flags.locked ? <Lock /> : <Unlock />}
            </button>
          </div>
          {hasChildren && expanded && layers(object.id)}
        </li>
      })}
    </ul>
  }

  return objects.length ? layers() : <p className="ic-inspector-status">This canvas has no layers yet.</p>
}

export function CanvasInspector({ project, stageWidth, selected, activeEdge, select, update, updateEdge, reorder, moveIntoFrame, fitFrame, settings, mediaTools, ...cardActions }: InspectorProps) {
  const panelId = useId()
  const bodyId = `${panelId}-body`
  const panel = project.settings.panel
  const nextSide = project.settings.inspectorSide === 'left' ? 'right' : 'left'
  const dockLabel = `Dock inspector on the ${nextSide}`
  if (panel === 'closed') return null

  const object = selected.length === 1 ? selected[0] : undefined
  const objects = new Map(project.objects.map(item => [item.id, item]))
  const edge = activeEdge && selected.length === 0 ? activeEdge : undefined

  return <ResizableInspector panelId={panelId} stageWidth={stageWidth} settings={project.settings}
    onResize={inspectorWidth => settings({ inspectorWidth })}>
    <aside id={panelId} className="ic-inspector" aria-label="Canvas inspector">
      <div className="ic-inspector-tabs" aria-label="Inspector panel">
        <button type="button" aria-pressed={panel === 'properties'} aria-controls={bodyId}
          onClick={() => settings({ panel: 'properties' })}><SlidersHorizontal /> Properties</button>
        <button type="button" aria-pressed={panel === 'layers'} aria-controls={bodyId}
          onClick={() => settings({ panel: 'layers' })}><Layers /> Layers</button>
        <button type="button" className="ic-inspector-icon ic-inspector-dock" aria-label={dockLabel} title={dockLabel}
          onClick={() => settings({ inspectorSide: nextSide })}>{nextSide === 'left' ? <PanelLeft /> : <PanelRight />}</button>
        <button type="button" className="ic-inspector-icon ic-inspector-close" aria-label="Close inspector"
          title="Close inspector" onClick={() => settings({ panel: 'closed' })}><X /></button>
      </div>
      <div id={bodyId} className="ic-inspector-body">
        {panel === 'layers' ? <ObjectLayers objects={project.objects} selected={selected} select={select} update={update} /> :
          edge ? <fieldset className="ic-inspector-section" key={edge.id}>
            <legend>{edge.kind.charAt(0).toUpperCase() + edge.kind.slice(1)}</legend>
            <TextField label="Label" value={edge.label} onCommit={label => updateEdge(edge, { label })} />
            <ColourPicker colour={edge.colour ?? colourForEdge[edge.kind]} swatches={project.swatches} onChange={colour => updateEdge(edge, { colour })} />
          </fieldset> :
          object ? <ObjectProperties key={object.id} object={object} objects={objects} update={update} reorder={reorder} moveIntoFrame={moveIntoFrame} fitFrame={fitFrame}
            mediaTools={mediaTools} swatches={project.swatches} {...cardActions} /> :
          <p className="ic-inspector-status">{selected.length ? selected.length + ' objects selected. Select one object to edit its properties.' : 'Select an object or connection to inspect it.'}</p>}
      </div>
    </aside>
  </ResizableInspector>
}
