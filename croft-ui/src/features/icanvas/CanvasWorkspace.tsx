import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import RBush from 'rbush'
import {
  ArrowDownToLine, ArrowRight, AudioLines, Box, ChevronDown, ChevronRight, Circle, Copy, Crop, Eye, FileText, GripHorizontal, Hand, Image,
  Layers, Lock, LockOpen, Maximize, Minus, MoreHorizontal, MousePointer2, PanelLeft, PenLine, Play, Plus, Redo2, RotateCw,
  Link2, Save, Search, SlidersHorizontal, Sparkles, Square, StickyNote, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash2, Type, Undo2, Unlink, X,
} from 'lucide-react'
import { ancestors, canFlip, cardFace, cardSide, colourForEdge, createProject, descendants, edgeLabels, imageAssetId, kinds, makeObject, objectFlags, palette, searchCanvasObjects,
  type Camera, type CanvasAsset, type CanvasEdge, type CanvasObject, type CanvasProject, type CanvasSettings, type CardSide, type EdgeKind, type ObjectKind, type Placement, type Point } from './model'
import {
  connectionEndpoints, containsPoint, fitFrameAround, fitFrameToContents, fitViewport, gridAtZoom, intersects, objectSnap, pinchViewport, placePoint, pointerAngle, rectCenter, renderOrigin,
  resizeFromCorner, rotatedBounds, screenToWorld, snapPoint, snapRotation, transformDescendant, worldToScreen, wrappedAngleDelta, zoomAt,
  type OrientedRect, type Rect,
} from './geometry'
import { CanvasInspector } from './CanvasInspector'
import { readableInk } from './colour'
import { CanvasThumbnail, ObjectContent } from './CanvasVisuals'
import { CardBackEditor, CardFlipControl } from './CardFaces'
import { CanvasDialog, ProjectDetails, ProjectIcon } from './ProjectViews'
import { CanvasSaveDialogs } from './CanvasSaveDialogs'
import { CanvasBackupDialog } from './CanvasBackupDialog'
import { CanvasExportDialog } from './CanvasExportDialog'
import { ImageTools } from './ImageTools'
import { AudioProperties } from './AudioProperties'
import type { AudioAppearance } from './audioAppearance'
import { parseSmartlink, providerLabel, readSmartlink, type SmartlinkContent, type SmartlinkMode } from './smartlinks'
import { defaultImageEdits, imageEffectInsets, imageFrameSize, readImageEdits, type ImageEdits } from './imageEdits'
import { getAsset } from './storage'
import { droppedCanvasFiles, ImportDialog, pickCanvasFiles, type CanvasFile, type CanvasPreparedAsset } from './ImportDialog'
import { useCanvasEditing } from './useCanvasEditing'
import { addToStack, canAddToStack, canStackCards, createStack, extractFromStack, layoutStacks, setStackLayout, showStackMember, unstackAll } from './stackScene'
import type { useCanvasProjects } from './useCanvasProjects'
import './canvas.css'
import './stacks.css'

type Tool = 'select' | 'hand' | 'text' | 'note' | 'rectangle' | 'ellipse' | 'stroke' | 'frame' | EdgeKind
type Popup = 'save' | 'view' | 'tools' | 'add' | 'edges' | 'shapes' | 'project' | 'zoom' | null
type Modal = 'details' | 'subcanvas' | 'move' | 'trash' | 'find' | 'versions' | 'checkpoint' | 'recovery' | 'copy' | 'export' | 'backup' | 'presentation' | 'embed' | 'link' | 'preview' | 'deleteStack' | 'smartlink' | null
type Indexed = { minX: number; minY: number; maxX: number; maxY: number; object: CanvasObject; index: number }
type Gesture = { start: Point; camera: Camera; pointerId: number } & (
  { kind: 'pan' | 'marquee' } | { kind: 'move'; objects: CanvasObject[]; pickup?: CanvasObject; drop?: string; preview: CanvasObject[] } |
  { kind: 'resize'; object: CanvasObject; excluded: Set<string>; preview: CanvasObject[] } | { kind: 'stroke'; points: Point[] } |
  { kind: 'rotate'; object: CanvasObject; center: Point; lastAngle: number; traveled: number; preview: CanvasObject[] })
const isEditor = (target: EventTarget | null) => target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable], [role="dialog"], dialog')
const shapeForAsset = (asset: CanvasAsset): ObjectKind =>
  asset.mime.startsWith('image/') ? 'image' : asset.mime.startsWith('audio/') ? 'audio' : asset.mime.startsWith('video/') ? 'video' : 'file'
const action = (label: string, run: () => void, icon?: React.ReactNode) => ({ label, run, icon })
const rotationIncrements = [5, 15, 30, 45, 90, 0]
const rotationEdges = ['top', 'right', 'bottom', 'left'] as const
const textAlignments = [
  { value: 'left', label: 'Align text left', icon: TextAlignStart },
  { value: 'center', label: 'Align text center', icon: TextAlignCenter },
  { value: 'right', label: 'Align text right', icon: TextAlignEnd },
] as const
const imageShortcuts = [
  { section: 'crop', label: 'Crop', icon: Crop },
  { section: 'adjust', label: 'Adjust', icon: SlidersHorizontal },
  { section: 'effects', label: 'Effects', icon: Sparkles },
] as const
type ImageShortcut = typeof imageShortcuts[number]['section']
const neutralImageEdits = JSON.stringify(defaultImageEdits)
const frameGeometry = ({ x, y, width, height, rotation }: OrientedRect): OrientedRect => ({ x, y, width, height, rotation })

function translateObject(object: CanvasObject, dx: number, dy: number): CanvasObject {
  const { frameBase } = object
  return { ...object, x: object.x + dx, y: object.y + dy,
    frameBase: frameBase && { ...frameBase, x: frameBase.x + dx, y: frameBase.y + dy } }
}

export function CanvasWorkspace({ project, store, sidebarOpen, sidebarToggleRef, toggleSidebar, openCanvas, goHome, openPage, jump, dark, openPrivacy, suspendEmbeds }: {
  project: CanvasProject; store: ReturnType<typeof useCanvasProjects>; sidebarOpen: boolean
  sidebarToggleRef: RefObject<HTMLButtonElement | null>; toggleSidebar: () => void
  openCanvas: (id: string, objectId?: string, side?: CardSide) => void; goHome: () => void; openPage: (id: string) => void
  jump?: { id: string; event: number; side?: CardSide }; dark: boolean; openPrivacy: () => void; suspendEmbeds?: boolean
}) {
  const { projects, update, write, flush, refresh, status, error } = store
  const canEdit = store.access === 'writer'
  const { edit, editSwatches, record, step, canUndo, canRedo, resetHistory } = useCanvasEditing(project, update)
  const stage = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const pointer = useRef<Point>({ x: 0, y: 0 })
  const lastCanvasPointer = useRef<Point | undefined>(undefined)
  const gesture = useRef<Gesture | null>(null)
  const touches = useRef(new Map<number, Point>())
  const pinch = useRef<{ ids: number[]; center: Point; distance: number; camera: Camera; latest: Camera } | undefined>(undefined)
  const tappedTool = useRef<{ id: number; position: Point; kind: ObjectKind } | undefined>(undefined)
  const space = useRef(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [tool, setTool] = useState<Tool>('select')
  const [selected, setSelected] = useState<string[]>([])
  const [rotateId, setRotateId] = useState<string>()
  const [rotationIncrement, setRotationIncrement] = useState(15)
  const [edgeId, setEdgeId] = useState('')
  const [fromId, setFromId] = useState('')
  const [popup, setPopup] = useState<Popup>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [smartlinkTarget, setSmartlinkTarget] = useState<{ id?: string; side: CardSide; point?: Point }>()
  const [smartlinkForm, setSmartlinkForm] = useState({ url: '', title: '', notes: '' })
  const [smartlinkBatch, setSmartlinkBatch] = useState<SmartlinkContent[]>()
  const [smartlinkError, setSmartlinkError] = useState('')
  const [smartlinkPriority, setSmartlinkPriority] = useState<string>()
  const [dragged, setDragged] = useState<CanvasObject[]>([])
  const [marquee, setMarquee] = useState<Rect>()
  const [guides, setGuides] = useState<Partial<Point>>()
  const [drawing, setDrawing] = useState<Point[]>([])
  const [cameraDraft, setCameraDraft] = useState<Camera>()
  const [readOnlyCamera, setReadOnlyCamera] = useState<Camera>()
  const [readOnlySettings, setReadOnlySettings] = useState<Partial<CanvasSettings>>({})
  const [toolbarDraft, setToolbarDraft] = useState<Point>()
  const [editing, setEditing] = useState<CanvasObject>()
  const [editingBack, setEditingBack] = useState<string>()
  const [imageSection, setImageSection] = useState<{ key: string; section: ImageShortcut; tick: number }>()
  const [imageDraft, setImageDraft] = useState<{ key: string; edits: ImageEdits }>()
  const [compareImage, setCompareImage] = useState<string>()
  const [selectedAsset, setSelectedAsset] = useState<{ id: string; mime?: string }>()
  const [files, setFiles] = useState<CanvasFile[]>()
  const [replaceId, setReplaceId] = useState('')
  const [replaceSide, setReplaceSide] = useState<CardSide>('front')
  const [stackToDelete, setStackToDelete] = useState<string>()
  const [stackDrop, setStackDrop] = useState<string>()
  const [pileMenu, setPileMenu] = useState<string>()
  const [readerView, setReaderView] = useState<CanvasObject[]>([])
  const [dropActive, setDropActive] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [placement, setPlacement] = useState<Placement>(() => {
    try { return localStorage.getItem('croft-icanvas-placement') === 'free' ? 'free' : 'smart' } catch { return 'smart' }
  })
  const [query, setQuery] = useState('')
  const [findScope, setFindScope] = useState('canvas')
  const [findKind, setFindKind] = useState('')
  const [preview, setPreview] = useState<CanvasObject>()
  const [contextPoint, setContextPoint] = useState<Point>()
  const [play, setPlay] = useState<{ index: number; automatic: boolean; loop: boolean; smooth: boolean }>()
  const [stopName, setStopName] = useState('')
  const [duration, setDuration] = useState(5)
  const [moveTarget, setMoveTarget] = useState(project.parentId ?? '')
  const chain = ancestors(projects, project.id)
  const children = projects.filter(item => item.parentId === project.id)
  const stageProject = play ? projects.find(item => item.id === project.stops[play.index]?.canvasId) ?? project : project
  const viewingCamera = canEdit ? project.camera : readOnlyCamera ?? project.camera
  const settings = canEdit ? project.settings : { ...project.settings, ...readOnlySettings }
  const camera = play ? project.stops[play.index]?.camera ?? project.camera : cameraDraft ?? viewingCamera
  const [previewZoom, setPreviewZoom] = useState(camera.zoom)
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1)
  const previewScale = previewZoom * Math.min(2, pixelRatio)
  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewZoom(camera.zoom), 120)
    return () => window.clearTimeout(timer)
  }, [camera.zoom])
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${pixelRatio}dppx)`)
    const sync = () => setPixelRatio(window.devicePixelRatio || 1)
    window.addEventListener('resize', sync)
    query.addEventListener('change', sync)
    return () => { window.removeEventListener('resize', sync); query.removeEventListener('change', sync) }
  }, [pixelRatio])
  const origin = renderOrigin(camera)
  const offset = worldToScreen(origin, camera)
  const gridSize = gridAtZoom(camera.zoom)
  const readerObjects = useMemo(() => {
    if (play || !readerView.length) return stageProject.objects
    const overrides = new Map(readerView.map(object => [object.id, object]))
    const map = new Map(stageProject.objects.map(object => [object.id, object]))
    return stageProject.objects.map(object => {
      const override = overrides.get(object.id)
      if (!override || (canEdit && (object.kind !== 'stack' || !objectFlags(object, map).locked))) return object
      return { ...object, visibleSide: override.visibleSide, stack: override.stack }
    })
  }, [canEdit, play, readerView, stageProject.objects])

  function startPresentation(automatic = false, loop = false, smooth = true) {
    if (!project.stops.length) return
    setPlay({ index: 0, automatic, loop, smooth })
    void stage.current?.parentElement?.requestFullscreen?.().catch(() => {})
  }

  const indexed = useMemo(() => {
    const map = new Map(readerObjects.map(object => [object.id, object]))
    const flags = new Map(readerObjects.map(object => [object.id, objectFlags(object, map)]))
    const pileLayout = layoutStacks(readerObjects)
    const visible = readerObjects.filter(object => !flags.get(object.id)?.hidden && object.kind !== 'group' && object.kind !== 'stack' && !pileLayout.obscured.has(object.id))
      .map(object => pileLayout.cards.get(object.id) ?? object)
    const order = new Map(readerObjects.map((object, index) => [object.id, index]))
    const tree = new RBush<Indexed>()
    tree.load(visible.map(object => {
      const box = rotatedBounds(object.collapsed ? { ...object, height: 36 } : object, object.rotation)
      const loadedEdits = imageAssetId(object) && cardFace(object).imageEdits
      const insets = loadedEdits && imageEffectInsets(loadedEdits)
      const padding = insets ? Math.max(insets.left, insets.right, insets.top, insets.bottom) * Math.SQRT2 : 0
      const layer = object.parentId && pileLayout.piles.has(object.parentId) ? object.parentId : object.id
      return { minX: box.left - padding, minY: box.top - padding, maxX: box.right + padding, maxY: box.bottom + padding, object, index: order.get(layer) ?? 0 }
    }))
    return { map, flags, visible, tree, pileLayout }
  }, [readerObjects])
  const dragMap = new Map(dragged.map(object => [object.id, object]))
  const displayedPiles = useMemo(() => {
    if (!dragged.length || !indexed.pileLayout.piles.size) return indexed.pileLayout
    const updates = new Map(dragged.map(object => [object.id, object]))
    return layoutStacks(readerObjects.map(object => updates.get(object.id) ?? object))
  },
  [indexed, readerObjects, dragged])
  const projected = (object: CanvasObject) => displayedPiles.cards.get(object.id) ?? dragMap.get(object.id) ?? object
  const topLeft = screenToWorld({ x: -100, y: -100 }, camera)
  const bottomRight = screenToWorld({ x: size.width + 100, y: size.height + 100 }, camera)
  const rendered = indexed.tree.search({ minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y })
    .filter(item => !displayedPiles.obscured.has(item.object.id)).sort((a, b) => a.index - b.index).map(item => projected(item.object))
  const displayed = new Set(rendered.map(object => object.id))
  for (const object of dragged) if (!displayed.has(object.id) && !['group', 'stack'].includes(object.kind) && !indexed.flags.get(object.id)?.hidden && !displayedPiles.obscured.has(object.id)) rendered.push(projected(object))
  for (const [id, card] of displayedPiles.cards) if (indexed.pileLayout.obscured.has(id) && !displayed.has(id)) rendered.push(card)
  const renderedIds = new Set(rendered.map(object => object.id))
  const activeSmartlinkIds = useMemo(() => {
    if (!size.width || suspendEmbeds || modal || files || editing || editingBack) return new Set<string>()
    const topLeft = screenToWorld({ x: 0, y: 0 }, camera)
    const bottomRight = screenToWorld({ x: size.width, y: size.height }, camera)
    const view = { ...topLeft, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
    const candidates = rendered.flatMap(object => {
      const link = cardSide(object) === 'back' ? object.back?.smartlink : object.smartlink
      if (!link || link.provider === 'website' || link.mode !== 'embed') return []
      if (indexed.pileLayout.obscured.has(object.id) || indexed.flags.get(object.id)?.hidden) return []
      const box = rotatedBounds(object, object.rotation)
      if (!intersects({ x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }, view) ||
          object.width * camera.zoom < 240 || object.height * camera.zoom < (cardSide(object) === 'back' ? 420 : 340)) return []
      return [object.id]
    })
    if (smartlinkPriority && candidates.includes(smartlinkPriority)) candidates.sort((a, b) => Number(b === smartlinkPriority) - Number(a === smartlinkPriority))
    return new Set(candidates.slice(0, 4))
  }, [rendered, size.width, size.height, camera.x, camera.y, camera.zoom, smartlinkPriority, suspendEmbeds, modal, files, editing, editingBack])
  const chosen = selected.flatMap(id => {
    const object = indexed.map.get(id)
    return object && !indexed.flags.get(id)?.hidden ? [object] : []
  })
  const singleSelection = chosen.length === 1 ? chosen[0] : undefined
  const contextSide = singleSelection ? cardSide(singleSelection) : 'front'
  const contextSmartlink = singleSelection ? (contextSide === 'back' ? singleSelection.back?.smartlink : singleSelection.smartlink) : undefined
  const imageSide = singleSelection ? cardSide(singleSelection) : 'front'
  const selectedFace = singleSelection ? cardFace(singleSelection) : undefined
  const inspectAssetId = selectedFace && (imageSide === 'back' || singleSelection?.kind === 'file') ? selectedFace.assetId : undefined
  useEffect(() => {
    if (!inspectAssetId) return
    let active = true
    void getAsset(inspectAssetId).then(asset => {
      if (active) setSelectedAsset({ id: inspectAssetId, mime: asset?.mime })
    }).catch(() => {
      if (active) setSelectedAsset({ id: inspectAssetId })
    })
    return () => { active = false }
  }, [inspectAssetId])
  const selectedMime = selectedAsset?.id === inspectAssetId ? selectedAsset?.mime : undefined
  const candidate = singleSelection && imageAssetId(singleSelection)
  const image = candidate && (imageSide === 'front' || selectedMime?.startsWith('image/') || selectedFace?.imageEdits) ? candidate : undefined
  const audio = selectedFace?.assetId && (imageSide === 'front' && singleSelection?.kind === 'audio' ||
    selectedMime?.startsWith('audio/') || selectedFace.audioAppearance) ? selectedFace.assetId : undefined
  const imageKey = image && singleSelection ? `${singleSelection.id}/${imageSide}/${image}` : undefined
  useEffect(() => {
    setImageDraft(undefined)
    setCompareImage(undefined)
    setImageSection(current => current?.key === imageKey ? current : undefined)
  }, [imageKey, settings.panel])
  const selectedGroup = canEdit && !play && chosen.length === 1 && chosen[0].kind === 'group' ? dragMap.get(chosen[0].id) ?? chosen[0] : undefined
  const rotateTarget = canEdit && !play && tool === 'select' && chosen.length === 1 && chosen[0].id === rotateId &&
    !chosen[0].collapsed && !indexed.flags.get(rotateId)?.locked ? projected(chosen[0]) : undefined
  const rotating = gesture.current?.kind === 'rotate'
  const rotationPosition = rotateTarget && worldToScreen(rectCenter(rotateTarget), camera)
  const selectionLocked = chosen.length === 1 && !!indexed.flags.get(chosen[0].id)?.locked
  const activeEdge = project.edges.find(edge => edge.id === edgeId)
  const panelOpen = canEdit && !play && settings.panel !== 'closed' && (chosen.length > 0 || !!activeEdge || settings.panel === 'layers')
  const selectedBounds = chosen.map(object => {
    const front = displayedPiles.piles.get(object.id)?.frontId
    return (front && displayedPiles.cards.get(front)) || projected(object)
  }).map(object => rotatedBounds(object, object.rotation))
  const quick = selectedBounds.length ? worldToScreen({
    x: Math.min(...selectedBounds.map(box => box.left)), y: Math.min(...selectedBounds.map(box => box.top)),
  }, camera) : undefined
  const updateSettings = (patch: Partial<CanvasSettings>) => {
    if (canEdit) update({ ...project, settings: { ...project.settings, ...patch } }, false)
    else setReadOnlySettings(previous => ({ ...previous, ...patch }))
  }
  const setCamera = (next: Camera) => {
    if (canEdit) update({ ...project, camera: next }, false)
    else setReadOnlyCamera(next)
  }
  const toggle = (next: Popup) => setPopup(current => current === next ? null : next)
  const show = (next: Modal) => { setPopup(null); setModal(next) }
  const onError = (reason: unknown) => setFeedback(reason instanceof Error ? reason.message : String(reason))
  const validForEdit = (object: CanvasObject) => canEdit && !indexed.flags.get(object.id)?.hidden && !indexed.flags.get(object.id)?.locked

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function jumpTo(id: string, side?: CardSide) {
    const item = project.objects.find(object => object.id === id)
    if (!item || !size.width) return
    if (indexed.flags.get(id)?.hidden) {
      setFeedback('This item is hidden. Reveal it in Layers to select it.')
      updateSettings({ panel: 'layers' })
      return
    }
    revealCard(item, side, true)
    setEdgeId('')
    const pile = item.parentId ? indexed.pileLayout.piles.get(item.parentId) : undefined
    const focus = item.kind === 'stack' && item.stack ? indexed.pileLayout.cards.get(item.stack.order[0]) ?? item
      : pile ? { ...item, x: pile.stack.x + (pile.stack.width - item.width) / 2, y: pile.stack.y + (pile.stack.height - item.height) / 2 } : item
    const nextCamera = fitViewport([focus], size, { max: 1.6 })
    if (canEdit) {
      const objects = revealObjects(item, side)
      if (objects === project.objects) setCamera(nextCamera)
      else edit(objects, project.edges, nextCamera)
    }
    else setReadOnlyCamera(nextCamera)
  }

  const completedJump = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (jump && size.width && completedJump.current !== jump.event) {
      completedJump.current = jump.event
      jumpTo(jump.id, jump.side)
    }
  }, [jump, size.width])

  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !size.width || !indexed.visible.length || jump) return
    fitted.current = true
    if (project.camera.x === 0 && project.camera.y === 0 && project.camera.zoom === 1) {
      setCamera(fitViewport(indexed.visible, size, { max: 1, padding: 104 }))
    }
  }, [size.width, indexed.visible.length])

  function localPoint(event: { clientX: number; clientY: number }) {
    const box = stage.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }

  function pasteSmartlink(event: ReactClipboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || !canEdit || play || modal || files || editing || editingBack || event.clipboardData.files.length) return
    const path = event.nativeEvent.composedPath()
    if (path.some(node => node instanceof HTMLElement && (node.isContentEditable || node.matches('input, textarea, select, [role="dialog"]') ||
      !!node.closest('input, textarea, select, [contenteditable], [role="dialog"], dialog, .ic-dialog')))) return
    if ([...event.clipboardData.items].some(item => item.type.startsWith('image/'))) return
    const text = event.clipboardData.getData('text/plain').trim()
    const single = parseSmartlink(text)
    const point = lastCanvasPointer.current
    if (single) {
      event.preventDefault()
      createSmartlinkObjects([single], point)
      return
    }
    const tokens = text.split(/\s+/).filter(Boolean)
    if (tokens.length < 2) return
    const links = tokens.map(token => parseSmartlink(token))
    if (links.some(link => !link)) return
    event.preventDefault()
    if (tokens.length > 10) { setFeedback('Paste up to 10 links at a time. Split the batch; Croft did not create any objects.'); return }
    setSmartlinkTarget({ side: 'front', point })
    setSmartlinkBatch(links as SmartlinkContent[])
    setSmartlinkForm({ url: '', title: '', notes: '' })
    setSmartlinkError('')
    show('smartlink')
  }

  function pick(id: string, multiple = false) {
    const maybe = project.objects.find(object => object.id === id)
    if (maybe && !indexed.flags.get(id)?.hidden) {
      setEdgeId('')
      if (multiple || id !== rotateId) setRotateId(undefined)
      setSelected(current => multiple ? current.includes(id) ? current.filter(entry => entry !== id) : [...current, id] : [id])
    }
  }

  function revealObjects(object: CanvasObject, side?: CardSide) {
    const parent = object.parentId ? indexed.map.get(object.parentId) : undefined
    let objects = canEdit ? project.objects : readerObjects
    if (parent?.stack && parent.stack.order[0] !== object.id && !(canEdit && indexed.flags.get(parent.id)?.locked)) {
      // Browsing is allowed on locks. Hidden/collapsed ownership still governs visibility.
      objects = showStackMember(objects, parent.id, object.id, { preview: true })
    }
    if (side && canFlip(object) && cardSide(indexed.map.get(object.id) ?? object) !== side) {
      objects = objects.map(item => item.id === object.id ? { ...item, visibleSide: side } : item)
    }
    return objects
  }

  function revealCard(object: CanvasObject, side?: CardSide, jump = false) {
    if (indexed.flags.get(object.id)?.hidden) { setFeedback('Show the card or expand its frame in Layers first.'); return }
    if (side === 'back' && !canFlip(object)) setFeedback('This object’s Back is preserved. Switch its display to Card to see it.')
    const objects = revealObjects(object, side)
    if (canEdit) {
      const parent = object.parentId ? indexed.map.get(object.parentId) : undefined
      if (parent?.stack && indexed.flags.get(parent.id)?.locked && parent.stack.order[0] !== object.id) {
        const order = [object.id, ...parent.stack.order.filter(id => id !== object.id)]
        setReaderView(current => [...current.filter(item => item.id !== parent.id), { ...parent, stack: { ...parent.stack!, order } }])
      }
      if (!jump && objects !== project.objects) edit(objects)
    } else {
      setReaderView(objects.filter((item, index) => item !== project.objects[index]))
    }
    pick(object.id)
  }

  function flipCard(object: CanvasObject) {
    const current = indexed.map.get(object.id) ?? object
    if (!canFlip(current) || indexed.flags.get(current.id)?.hidden) return
    const visibleSide = cardSide(current) === 'front' ? 'back' : 'front'
    if (canEdit) edit(project.objects.map(item => item.id === current.id ? { ...item, visibleSide } : item))
    else setReaderView(items => [...items.filter(item => item.id !== current.id), { ...current, visibleSide }])
    pick(current.id)
  }

  function stackAction(action: () => CanvasObject[], select?: string) {
    if (!canEdit) return
    try {
      const objects = action()
      const ids = new Set(objects.map(item => item.id))
      edit(objects, project.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)))
      if (select) { setSelected([select]); setEdgeId('') }
    } catch (reason) { onError(reason) }
  }

  function stackSelection() {
    if (!canEdit) return
    try {
      const { stackId, objects } = createStack(project.objects, selected)
      edit(objects)
      setSelected([stackId])
      setContextPoint(undefined)
    } catch (reason) { onError(reason) }
  }

  function removeFromStack(member: CanvasObject) {
    if (member.parentId) stackAction(() => extractFromStack(project.objects, member.parentId!, member.id), member.id)
  }

  function changeStackLayout(stack: CanvasObject, fanned: boolean) {
    if (canEdit) stackAction(() => setStackLayout(project.objects, stack.id, fanned ? 'fan' : 'compact'))
    else {
      try {
        const current = setStackLayout(readerObjects, stack.id, fanned ? 'fan' : 'compact', { preview: true })
        setReaderView(current.filter((item, index) => item !== stageProject.objects[index]))
      } catch (reason) { onError(reason) }
    }
  }

  function chooseTool(next: Tool) {
    setFromId('')
    setTool(next)
    setRotateId(undefined)
    setPopup(null)
    setContextPoint(undefined)
  }

  function transformObjects(object: CanvasObject, patch: Partial<CanvasObject>): CanvasObject[] {
    const next = { ...object, ...patch }
    const container = object.kind === 'group' || object.kind === 'frame' || object.kind === 'stack'
    const moving = next.x !== object.x || next.y !== object.y
    const resizing = next.width !== object.width || next.height !== object.height
    const rotating = next.rotation !== object.rotation
    const scale = container && resizing ? next.width !== object.width ? next.width / object.width : next.height / object.height : 1
    if (container && resizing) {
      next.width = object.width * scale
      next.height = object.height * scale
    }
    if (object.frameBase) {
      next.frameBase = resizing ? undefined : moving || rotating
        ? transformDescendant(object.frameBase, object, next, 1) : object.frameBase
    }
    if (object.kind === 'stroke' && object.points && resizing) {
      next.points = object.points.map(point => ({ x: point.x * next.width / object.width, y: point.y * next.height / object.height }))
    }
    if (!container || !(moving || resizing || rotating)) return [next]
    const members = expandSelection([object.id])
    if (!canTransform(members)) return []
    return [next, ...project.objects.filter(item => item.id !== object.id && members.has(item.id)).map(item => ({
      ...transformDescendant(item, object, next, scale),
      frameBase: item.frameBase && transformDescendant(item.frameBase, object, next, scale),
    }))]
  }

  function changeObject(object: CanvasObject, patch: Partial<CanvasObject>) {
    if (!canEdit) return
    if (!validForEdit(object) && patch.locked === undefined && patch.hidden === undefined) return
    const parent = object.parentId ? indexed.map.get(object.parentId) : undefined
    if (parent?.kind === 'stack' && patch.mode && !canFlip({ ...object, mode: patch.mode })) {
      setFeedback('Remove this member from its stack before switching to Direct display.')
      return
    }
    const next = new Map(transformObjects(object, patch).map(item => [item.id, item]))
    if (next.size) edit(project.objects.map(item => next.get(item.id) ?? item))
  }

  function commitImageEdits(id: string, side: CardSide, asset: string, draft?: ImageEdits) {
    setImageDraft(undefined)
    const object = project.objects.find(item => item.id === id)
    if (!object || !validForEdit(object) || imageAssetId(object, side) !== asset) return
    const previous = cardFace(object, side)
    try {
      const parsed = draft ? readImageEdits(draft) : undefined
      const imageEdits = JSON.stringify(parsed) === neutralImageEdits ? undefined : parsed
      if (JSON.stringify(previous.imageEdits) === JSON.stringify(imageEdits)) return
      changeObject(object, side === 'front' ? { imageEdits } : { back: { ...previous, imageEdits } })
    } catch (reason) { onError(reason) }
  }

  function commitAudioAppearance(id: string, side: CardSide, asset: string, appearance?: AudioAppearance) {
    const object = project.objects.find(item => item.id === id)
    if (!object || !validForEdit(object)) return
    const face = cardFace(object, side)
    if (face.assetId !== asset || JSON.stringify(face.audioAppearance) === JSON.stringify(appearance)) return
    changeObject(object, side === 'back' ? { back: { ...face, audioAppearance: appearance } } : { audioAppearance: appearance })
  }

  function canTransform(ids: Set<string>) {
    if ([...ids].some(id => indexed.flags.get(id)?.locked)) {
      setFeedback('Unlock all objects in this selection before transforming it.')
      return false
    }
    return true
  }

  function reorder(id: string, direction: 'front' | 'back' | 'forward' | 'backward') {
    const objects = [...project.objects]
    const index = objects.findIndex(object => object.id === id)
    if (index < 0 || !validForEdit(objects[index])) return
    const parentId = objects[index].parentId
    const parent = parentId ? indexed.map.get(parentId) : undefined
    if (parent?.stack) {
      const order = [...parent.stack.order]
      const previous = order.indexOf(id)
      const next = direction === 'front' ? 0 : direction === 'back' ? order.length - 1 : previous + (direction === 'forward' ? -1 : 1)
      if (previous < 0 || next < 0 || next >= order.length || previous === next) return
      order.splice(previous, 1)
      order.splice(next, 0, id)
      edit(objects.map(item => item.id === parent.id ? { ...item, stack: { ...parent.stack!, order } } : item))
      if (order[0] !== id && parent.stack.layout === 'compact') setSelected([parent.id])
      return
    }
    const next = direction === 'front' ? objects.length - 1 : direction === 'back' ? 0 : index + (direction === 'forward' ? 1 : -1)
    if (next === index || next < 0 || next >= objects.length) return
    const [object] = objects.splice(index, 1)
    objects.splice(next, 0, object)
    edit(objects)
  }

  function expandSelection(ids: string[]) {
    const result = new Set(ids)
    for (const item of project.objects) {
      let parentId = item.parentId
      const seen = new Set([item.id])
      while (parentId && !seen.has(parentId)) {
        if (result.has(parentId)) { result.add(item.id); break }
        seen.add(parentId)
        parentId = indexed.map.get(parentId)?.parentId
      }
    }
    return result
  }

  function removeSelection() {
    if (activeEdge) {
      edit(project.objects, project.edges.filter(edge => edge.id !== activeEdge.id))
      setEdgeId('')
      return
    }
    const ids = new Set(chosen.filter(validForEdit).map(item => item.id))
    if (!ids.size) return
    const stack = chosen.find(item => item.kind === 'stack')
    if (stack) {
      if (chosen.length > 1) { setFeedback('Select a single stack to choose how to delete it.'); return }
      setStackToDelete(stack.id); show('deleteStack'); return
    }
    let objects = project.objects
    for (const item of chosen) {
      if (ids.has(item.id) && item.parentId && indexed.map.get(item.parentId)?.stack) {
        try { objects = extractFromStack(objects, item.parentId, item.id) } catch (reason) { onError(reason); return }
      }
    }
    const formerParents = new Set(chosen.filter(item => ids.has(item.id)).map(item => item.parentId))
    const remaining = objects.filter(item => !ids.has(item.id))
      .map(item => item.parentId && ids.has(item.parentId) ? { ...item, parentId: undefined } : item)
    const changes = new Map<string, CanvasObject>()
    for (const parentId of formerParents) if (parentId) refitFormerFrames(parentId, changes, remaining, ids)
    const retained = new Set(remaining.map(item => item.id))
    edit(remaining.map(item => changes.get(item.id) ?? item), project.edges.filter(edge => retained.has(edge.from) && retained.has(edge.to)))
    setSelected([])
  }

  function duplicate() {
    const copies = chosen.filter(validForEdit).filter(item => !['canvas', 'frame', 'group', 'stack'].includes(item.kind)).map(item => ({
      ...item, id: crypto.randomUUID(), x: projected(item).x + 24, y: projected(item).y + 24,
      parentId: item.parentId && indexed.map.get(item.parentId)?.stack ? indexed.map.get(item.parentId)?.parentId : item.parentId,
    }))
    if (!copies.length) return
    edit([...project.objects, ...copies])
    setSelected(copies.map(item => item.id))
  }

  function groupSelection() {
    const items = chosen.filter(validForEdit)
    if (items.length < 2 || items.some(item => item.parentId !== items[0].parentId || item.parentId && indexed.map.get(item.parentId)?.stack)) return
    const bounds = items.map(item => rotatedBounds(item, item.rotation))
    const left = Math.min(...bounds.map(item => item.left))
    const top = Math.min(...bounds.map(item => item.top))
    const group = makeObject('group', { x: left, y: top }, { parentId: items[0].parentId,
      width: Math.max(...bounds.map(item => item.right)) - left, height: Math.max(...bounds.map(item => item.bottom)) - top })
    edit([...project.objects.map(item => items.includes(item) ? { ...item, parentId: group.id } : item), group])
    setSelected([group.id])
  }

  function ungroup(object: CanvasObject) {
    if (!validForEdit(object)) return
    edit(project.objects.filter(item => item.id !== object.id).map(item => item.parentId === object.id ? { ...item, parentId: object.parentId } : item),
      project.edges.filter(edge => edge.from !== object.id && edge.to !== object.id))
    setSelected(project.objects.filter(item => item.parentId === object.id).map(item => item.id))
  }

  function moveIntoFrame(object: CanvasObject, frameId: string) {
    const frame = frameId ? indexed.map.get(frameId) : undefined
    if (!validForEdit(object) || frame?.id === object.parentId) return
    if (frameId && (!frame || frame.kind !== 'frame' || frame.collapsed || !validForEdit(frame) || expandSelection([object.id]).has(frameId))) return
    if (object.parentId && indexed.map.get(object.parentId)?.stack) { setFeedback('Remove the card from its stack before changing its container.'); return }
    const placed = { ...object, parentId: frame?.id }
    const changes = new Map([[object.id, placed]])
    refitFormerFrames(object.parentId, changes)
    growFrames(placed, changes)
    edit(project.objects.map(item => changes.get(item.id) ?? item))
  }

  function frameChildren(frameId: string, changes: Map<string, CanvasObject>, objects = project.objects) {
    return objects.map(item => changes.get(item.id) ?? item).filter(item => item.parentId === frameId)
  }

  function refitFormerFrames(parentId: string | undefined, changes: Map<string, CanvasObject>, objects = project.objects,
    removed?: ReadonlySet<string>) {
    const seen = new Set<string>()
    while (parentId && !seen.has(parentId)) {
      const frame = changes.get(parentId) ?? indexed.map.get(parentId)
      if (!frame || indexed.flags.get(frame.id)?.locked) break
      seen.add(frame.id)
      parentId = frame.parentId
      if (removed?.has(frame.id) || frame.kind !== 'frame' || frame.collapsed || !frame.frameBase) continue
      const baseline = { ...frame, ...frame.frameBase }
      const fitted = frameChildren(frame.id, changes, objects).reduce(fitFrameAround<CanvasObject>, baseline)
      changes.set(frame.id, fitted === baseline ? { ...baseline, frameBase: undefined } : fitted)
    }
  }

  function fitFrame(frame: CanvasObject) {
    if (!validForEdit(frame) || frame.kind !== 'frame' || frame.collapsed) return
    const changes = new Map<string, CanvasObject>()
    const fitted = fitFrameToContents(frame, frameChildren(frame.id, changes))
    if (fitted === frame && !frame.frameBase) return
    changes.set(frame.id, { ...fitted, frameBase: undefined })
    refitFormerFrames(frame.parentId, changes)
    growFrames(changes.get(frame.id)!, changes)
    edit(project.objects.map(item => changes.get(item.id) ?? item))
  }

  function growFrames(child: CanvasObject, changes: Map<string, CanvasObject>) {
    const seen = new Set([child.id])
    while (child.parentId && !seen.has(child.parentId)) {
      const parent = changes.get(child.parentId) ?? indexed.map.get(child.parentId)
      if (!parent || indexed.flags.get(parent.id)?.locked) break
      seen.add(parent.id)
      child = parent.kind === 'frame' && !parent.collapsed ? fitFrameAround(parent, child) : parent
      if (child !== parent) {
        child = { ...child, frameBase: parent.frameBase ?? frameGeometry(parent) }
        changes.set(child.id, child)
      }
    }
  }

  function frameAt(point: Point) {
    return indexed.tree.search({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y })
      .sort((a, b) => b.index - a.index)
      .find(({object}) => object.kind === 'frame' && !object.collapsed && !indexed.flags.get(object.id)?.locked && containsPoint(object, point))?.object
  }

  function add(kind: ObjectKind, point = screenToWorld({ x: size.width * .5, y: size.height * .45 }, camera), patch?: Partial<CanvasObject>) {
    const position = project.settings.snapGrid && placement === 'smart' ? placePoint(point, placement) : point
    const containing = frameAt(position)
    const object = makeObject(kind, position, { parentId: containing?.id, ...patch })
    const changes = new Map<string, CanvasObject>()
    growFrames(object, changes)
    edit([...project.objects.map(item => changes.get(item.id) ?? item), object])
    setSelected([object.id])
    setEdgeId('')
    if (kind === 'text' || kind === 'note') setEditing(object)
    return object
  }

  function openSmartlinkEditor(object?: CanvasObject, side: CardSide = 'front', point?: Point) {
    const existing = object ? (side === 'back' ? object.back?.smartlink : object.smartlink) : undefined
    setSmartlinkTarget({ id: object?.id, side, point })
    setSmartlinkForm({ url: existing?.canonicalUrl ?? '', title: existing?.title ?? '', notes: existing?.notes ?? '' })
    setSmartlinkBatch(undefined)
    setSmartlinkError('')
    show('smartlink')
  }

  function createSmartlinkObjects(links: SmartlinkContent[], point?: Point) {
    if (!canEdit || !links.length || links.length > 10) return
    const screen = point ?? lastCanvasPointer.current ?? { x: size.width * .5, y: size.height * .45 }
    const base = screenToWorld(screen, camera)
    const created = links.map((smartlink, index) => {
      const nextPoint = project.settings.snapGrid && placement === 'smart'
        ? placePoint({ x: base.x + index % 2 * 400, y: base.y + Math.floor(index / 2) * 300 }, placement)
        : { x: base.x + index % 2 * 400, y: base.y + Math.floor(index / 2) * 300 }
      const container = frameAt(nextPoint)
      return makeObject('smartlink', nextPoint, { name: smartlink.title || providerLabel(smartlink.provider), parentId: container?.id, smartlink })
    })
    edit([...project.objects, ...created])
    setSelected(created.map(object => object.id))
    setEdgeId('')
  }

  function applySmartlinkEditor() {
    if (!canEdit) { setSmartlinkError('This canvas is read-only in the current tab.'); return }
    try {
      if (smartlinkBatch) {
        createSmartlinkObjects(smartlinkBatch, smartlinkTarget?.point)
        setModal(null)
        return
      }
      const parsed = parseSmartlink(smartlinkForm.url)
      if (!parsed) throw new Error('Enter one valid HTTP or HTTPS link.')
      const target = smartlinkTarget?.id ? project.objects.find(object => object.id === smartlinkTarget.id) : undefined
      const side = smartlinkTarget?.side ?? 'front'
      const prior = target ? (side === 'back' ? target.back?.smartlink : target.smartlink) : undefined
      if (prior && prior.canonicalUrl !== parsed.canonicalUrl && !window.confirm('Replace this Smartlink URL? Its notes and object placement will be kept.')) return
      const mode = prior?.provider === parsed.provider ? prior.mode : parsed.mode
      const smartlink = readSmartlink({ ...parsed, mode, title: smartlinkForm.title.trim() || undefined, notes: smartlinkForm.notes.trim() || undefined })
      if (!target) {
        createSmartlinkObjects([smartlink], smartlinkTarget?.point)
        setModal(null)
        return
      }
      if (!validForEdit(target)) throw new Error('Unlock this object before changing its Smartlink.')
      const face = cardFace(target, side)
      if (face.assetId && !face.smartlink && !window.confirm(`Replace the ${side} face attachment with this Smartlink? Undo restores the attachment.`)) return
      if (side === 'back') changeObject(target, { back: { ...face, assetId: undefined, imageEdits: undefined, audioAppearance: undefined, smartlink } })
      else changeObject(target, { assetId: undefined, imageEdits: undefined, audioAppearance: undefined, smartlink })
      setModal(null)
    } catch (reason) { setSmartlinkError(reason instanceof Error ? reason.message : String(reason)) }
  }

  function changeSmartlinkMode(object: CanvasObject, side: CardSide, mode: SmartlinkMode) {
    const current = side === 'back' ? object.back?.smartlink : object.smartlink
    if (!current || !validForEdit(object) || current.mode === mode) return
    const next = readSmartlink({ ...current, mode })
    changeObject(object, side === 'back' ? { back: { ...cardFace(object, 'back'), smartlink: next } } : { smartlink: next })
  }

  function updateSmartlink(object: CanvasObject, side: CardSide, patch: Partial<SmartlinkContent>) {
    const current = side === 'back' ? object.back?.smartlink : object.smartlink
    if (!current || !validForEdit(object)) return
    try {
      const next = readSmartlink({ ...current, ...patch })
      changeObject(object, side === 'back' ? { back: { ...cardFace(object, 'back'), smartlink: next } } : { smartlink: next })
    } catch (reason) { onError(reason) }
  }

  function removeSmartlink(object: CanvasObject, side: CardSide) {
    if (!validForEdit(object)) return
    if (side === 'back') changeObject(object, { back: { ...cardFace(object, 'back'), smartlink: undefined } })
    else if (object.kind === 'smartlink') changeObject(object, { kind: 'note', smartlink: undefined })
    else changeObject(object, { smartlink: undefined })
  }

  function connect(id: string) {
    if (!(tool in edgeLabels)) return
    if (!fromId) { setFromId(id); setFeedback('Select the destination object.'); return }
    if (fromId === id) return
    const edge: CanvasEdge = { id: crypto.randomUUID(), kind: tool as EdgeKind, from: fromId, to: id,
      label: tool === 'relationship' ? 'Related to' : '' }
    edit(project.objects, [...project.edges, edge])
    setEdgeId(edge.id)
    setSelected([])
    setFromId('')
    setFeedback('')
    setTool('select')
  }

  function startPileDrag(event: ReactPointerEvent<HTMLElement>, object: CanvasObject, extracting = false) {
    event.stopPropagation()
    if (event.button !== 0 || !validForEdit(object) || gesture.current) return
    const ids = expandSelection([object.id])
    if (!canTransform(ids)) return
    const start = localPoint(event)
    gesture.current = { kind: 'move', start, camera, pointerId: event.pointerId, preview: [], pickup: extracting ? projected(object) : undefined,
      objects: project.objects.filter(item => ids.has(item.id)) }
    setSelected([object.id])
    setPopup(null)
    setContextPoint(undefined)
    event.preventDefault()
    stage.current?.setPointerCapture(event.pointerId)
  }

  function start(event: ReactPointerEvent<HTMLElement>, object?: CanvasObject, handle?: 'resize') {
    if (play || (event.button !== 0 && event.button !== 1) || isEditor(event.target) ||
      (event.target instanceof Element && event.target.closest('audio, video, a, [data-media-control]'))) return
    if (object && !handle && tool === 'select' && !space.current && event.button === 0 &&
      event.target instanceof Element && event.target.closest('[data-selectable-card-text]')) {
      pick(object.id, event.shiftKey)
      return
    }
    const screen = localPoint(event)
    pointer.current = screen
    lastCanvasPointer.current = screen
    const world = screenToWorld(screen, camera)
    setPopup(null)
    setContextPoint(undefined)
    if (event.button === 1 || tool === 'hand' || space.current || event.pointerType === 'touch' && tool === 'select' && !object) {
      gesture.current = { start: screen, camera, kind: 'pan', pointerId: event.pointerId }
    } else if (!canEdit) {
      if (object) pick(object.id, event.shiftKey)
      else setSelected([])
      return
    } else if (object && tool in edgeLabels) {
      event.stopPropagation()
      connect(object.id)
      return
    } else if (tool === 'stroke') {
      gesture.current = { start: screen, camera, kind: 'stroke', points: [world], pointerId: event.pointerId }
      setDrawing([world])
    } else if (tool !== 'select') {
      if (['text', 'note', 'rectangle', 'ellipse', 'frame'].includes(tool)) {
        if (event.pointerType === 'touch') {
          tappedTool.current = { id: event.pointerId, position: world, kind: tool as ObjectKind }
          stage.current?.setPointerCapture(event.pointerId)
          return
        }
        add(tool as ObjectKind, world)
        setTool('select')
      }
      return
    } else if (object) {
      const canonical = indexed.map.get(object.id) ?? object
      const group = canonical.parentId ? indexed.map.get(canonical.parentId) : undefined
      const target = !handle && !event.shiftKey && group?.kind === 'group' ? group : canonical
      if (!handle && (event.shiftKey || !selected.includes(target.id))) pick(target.id, event.shiftKey)
      if ((!handle && event.shiftKey) || !validForEdit(target)) return
      if (!handle && group?.kind === 'stack') return
      const active = expandSelection(selected.includes(target.id) ? selected : [target.id])
      if (!canTransform(active)) return
      gesture.current = handle ? { start: screen, camera, kind: handle, object: target, excluded: active, preview: [], pointerId: event.pointerId } : {
        start: screen, camera, kind: 'move', pointerId: event.pointerId, preview: [], objects: project.objects.filter(item =>
          active.has(item.id) && !indexed.flags.get(item.id)?.locked),
      }
    } else {
      setSelected([])
      setRotateId(undefined)
      setEdgeId('')
      gesture.current = { start: screen, camera, kind: 'marquee', pointerId: event.pointerId }
    }
    event.preventDefault()
    const target = gesture.current?.kind === 'move' ? event.currentTarget : stage.current
    target?.setPointerCapture(event.pointerId)
  }

  function startRotation(event: ReactPointerEvent<HTMLButtonElement>, object: CanvasObject) {
    if (event.button !== 0 || gesture.current || !validForEdit(object) || !canTransform(expandSelection([object.id]))) return
    const start = localPoint(event)
    const center = worldToScreen(rectCenter(projected(object)), camera)
    event.stopPropagation()
    event.preventDefault()
    gesture.current = { kind: 'rotate', start, camera, pointerId: event.pointerId, object, center,
      lastAngle: pointerAngle(start, center), traveled: 0, preview: [] }
    stage.current?.setPointerCapture(event.pointerId)
  }

  function updateRotation(active: Extract<Gesture, { kind: 'rotate' }>, screen: Point, free: boolean) {
    if (Math.hypot(screen.x - active.center.x, screen.y - active.center.y) < 5) return
    const angle = pointerAngle(screen, active.center)
    active.traveled += wrappedAngleDelta(active.lastAngle, angle)
    active.lastAngle = angle
    const rotation = Math.abs(active.traveled) < .1 ? active.object.rotation
      : snapRotation(active.object.rotation + active.traveled, free ? 0 : rotationIncrement)
    const displayed = active.preview[0]?.rotation ?? active.object.rotation
    if (rotation === displayed) return
    active.preview = rotation === active.object.rotation ? [] : transformObjects(active.object, { rotation })
    setDragged(active.preview)
  }

  function updateResize(active: Extract<Gesture, { kind: 'resize' }>, screen: Point, free: boolean, keepRatio: boolean) {
    const source = active.object
    const zoom = active.camera.zoom
    const movement = { x: (screen.x - active.start.x) / zoom, y: (screen.y - active.start.y) / zoom }
    const container = source.kind === 'frame' || source.kind === 'group'
    const minimum = container ? { width: source.width * .01, height: source.height * .01 }
      : { width: Math.min(source.width, 24), height: Math.min(source.height, 24) }
    const proportional = keepRatio || container || source.kind === 'image' || source.kind === 'video'
    const unsnapped = resizeFromCorner(source, movement, minimum, proportional)
    let result = unsnapped
    if (!free && project.settings.snapObjects && !source.collapsed && Math.hypot(movement.x, movement.y) * zoom > 1) {
      const reach = 120 / zoom
      const bounds = rotatedBounds(unsnapped.rect, source.rotation)
      const neighbours = indexed.tree.search({ minX: bounds.left - reach, minY: bounds.top - reach,
        maxX: bounds.right + reach, maxY: bounds.bottom + reach })
        .filter(({ object }) => !active.excluded.has(object.id))
        .map(({ minX, minY, maxX, maxY }) => ({ left: minX, top: minY, right: maxX, bottom: maxY }))
      result = resizeFromCorner(source, movement, minimum, proportional, neighbours, 8 / zoom)
    }
    const { rect, guides: snapped } = result
    setGuides(project.settings.guides ? { x: snapped.x === undefined ? undefined : snapped.x * zoom + active.camera.x,
      y: snapped.y === undefined ? undefined : snapped.y * zoom + active.camera.y } : undefined)
    active.preview = Math.max(Math.abs(rect.width - source.width), Math.abs(rect.height - source.height)) < 1e-8
      ? [] : transformObjects(source, rect)
    setDragged(active.preview)
  }

  function trackTouch(event: ReactPointerEvent<HTMLDivElement>) {
    if (play || event.pointerType !== 'touch' || (event.target instanceof Element &&
      event.target.closest('button, input, video, audio, a, .ic-menu, .ic-inspector-shell, .ic-toolbar, .ic-minimap, .ic-zoom, [data-media-control]'))) return
    touches.current.set(event.pointerId, localPoint(event))
    if (touches.current.size < 2) return
    event.stopPropagation()
    event.preventDefault()
    if (pinch.current) return
    const [[a, first], [b, second]] = [...touches.current]
    tappedTool.current = undefined
    finish(false)
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    pinch.current = { ids: [a, b], center, distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)), camera, latest: camera }
    for (const id of pinch.current.ids) event.currentTarget.setPointerCapture(id)
  }

  function endPointer(event: ReactPointerEvent<HTMLDivElement>, commit = true) {
    touches.current.delete(event.pointerId)
    const activePinch = pinch.current
    if (activePinch) {
      if (!activePinch.ids.includes(event.pointerId)) return
      pinch.current = undefined
      if (commit) setCamera(activePinch.latest)
      setCameraDraft(undefined)
      return
    }
    const tap = tappedTool.current
    if (tap?.id === event.pointerId) {
      tappedTool.current = undefined
      if (commit && canEdit) { add(tap.kind, tap.position); setTool('select') }
      return
    }
    const active = gesture.current
    if (active?.pointerId !== event.pointerId) return
    if (commit && active.kind === 'rotate') updateRotation(active, localPoint(event), event.altKey)
    if (commit && active.kind === 'resize') updateResize(active, localPoint(event), event.altKey, event.shiftKey)
    if (commit && active.kind === 'move') active.drop = stackDropTarget(event.clientX, event.clientY, active)
    finish(commit)
  }

  function movingCardIds(active: Extract<Gesture, { kind: 'move' }>) {
    if (active.pickup) return []
    const ids = active.objects.map(item => item.id)
    return ids.length && active.objects.every(canFlip) ? ids : []
  }

  function stackDropTarget(clientX: number, clientY: number, active: Extract<Gesture, { kind: 'move' }>) {
    const stack = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-add-to-stack]')?.dataset.addToStack
    return stack && active.preview.length && canAddToStack(project.objects, stack, movingCardIds(active)) ? stack : undefined
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const screen = localPoint(event)
    pointer.current = screen
    lastCanvasPointer.current = screen
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, screen)
    const activePinch = pinch.current
    if (activePinch) {
      const [first, second] = activePinch.ids.map(id => touches.current.get(id))
      if (!first || !second) return
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      activePinch.latest = pinchViewport(activePinch.camera, activePinch.center, center,
        Math.hypot(first.x - second.x, first.y - second.y) / activePinch.distance)
      setCameraDraft(activePinch.latest)
      return
    }
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    const dx = screen.x - active.start.x
    const dy = screen.y - active.start.y
    const delta = { x: dx / camera.zoom, y: dy / camera.zoom }
    if (active.kind === 'pan') setCameraDraft({ ...active.camera, x: active.camera.x + dx, y: active.camera.y + dy })
    if (active.kind === 'marquee') setMarquee({ x: Math.min(screen.x, active.start.x), y: Math.min(screen.y, active.start.y), width: Math.abs(dx), height: Math.abs(dy) })
    if (active.kind === 'stroke') {
      active.points.push(screenToWorld(screen, camera))
      setDrawing([...active.points])
    }
    if (active.kind === 'rotate') {
      updateRotation(active, screen, event.altKey)
    }
    if (active.kind === 'resize') updateResize(active, screen, event.altKey, event.shiftKey)
    if (active.kind === 'move' && active.objects.length && Math.hypot(dx, dy) > 2) {
      if (active.pickup) {
        const card = active.pickup
        active.preview = [{ ...card, parentId: undefined, x: card.x + delta.x, y: card.y + delta.y }]
        setDragged(active.preview)
        return
      }
      const source = active.objects.find(item => selected.includes(item.id)) ?? active.objects[0]
      const proposed = { x: source.x + delta.x, y: source.y + delta.y }
      let position = project.settings.snapGrid && !event.altKey ? snapPoint(proposed) : proposed
      let snapped = { x: position.x !== proposed.x, y: position.y !== proposed.y }
      if (project.settings.snapObjects && !event.altKey) {
        const tolerance = 7 / camera.zoom
        const moving = new Set(active.objects.map(object => object.id))
        const reach = Math.max(384, 200 / camera.zoom)
        const neighbours = indexed.tree.search({ minX: proposed.x - reach, minY: proposed.y - reach,
          maxX: proposed.x + source.width + reach, maxY: proposed.y + source.height + reach })
          .map(entry => entry.object).filter(target => !moving.has(target.id))
        const result = objectSnap({ ...source, ...proposed }, neighbours, tolerance)
        position = { x: result.axes.x ? result.point.x : position.x, y: result.axes.y ? result.point.y : position.y }
        snapped = { x: snapped.x || !!result.axes.x, y: snapped.y || !!result.axes.y }
      }
      const at = worldToScreen(position, camera)
      setGuides(project.settings.guides ? { x: snapped.x ? at.x : undefined, y: snapped.y ? at.y : undefined } : undefined)
      active.preview = active.objects.map(item => translateObject(item, position.x - source.x, position.y - source.y))
      active.drop = stackDropTarget(event.clientX, event.clientY, active)
      setStackDrop(active.drop)
      setDragged(active.preview)
    }
  }

  function finish(commit = true) {
    const active = gesture.current
    gesture.current = null
    if (commit && active?.kind === 'pan' && cameraDraft) setCamera(cameraDraft)
    if (commit && active?.kind === 'marquee' && marquee && marquee.width + marquee.height > 4) {
      const bounds = screenToWorld(marquee, camera)
      setSelected(indexed.visible.filter(object => intersects(object, { ...bounds, width: marquee.width / camera.zoom, height: marquee.height / camera.zoom })).map(object => object.id))
    }
    if (commit && active?.kind === 'stroke' && active.points.length > 1) {
      const xs = active.points.map(point => point.x)
      const ys = active.points.map(point => point.y)
      const x = Math.min(...xs) - 4
      const y = Math.min(...ys) - 4
      add('stroke', { x, y }, { x, y, width: Math.max(...xs) - x + 4, height: Math.max(...ys) - y + 4,
        colour: palette[6], points: active.points.map(point => ({ x: point.x - x, y: point.y - y })), strokeWidth: 3 })
    }
    const changed = active?.kind === 'rotate' || active?.kind === 'resize' || active?.kind === 'move' ? active.preview : dragged
    if (commit && changed.length) {
      const next = new Map(changed.map(object => [object.id, object]))
      if (active?.kind === 'move' && active.pickup?.parentId) {
        const pickup = active.pickup
        stackAction(() => extractFromStack(project.objects, pickup.parentId!, pickup.id, changed[0]), pickup.id)
      } else if (active?.kind === 'move' && active.drop) {
        stackAction(() => addToStack(project.objects.map(object => next.get(object.id) ?? object), active.drop!, movingCardIds(active)), active.drop)
      } else edit(project.objects.map(object => next.get(object.id) ?? object))
    }
    setDragged([])
    setStackDrop(undefined)
    setMarquee(undefined)
    setGuides(undefined)
    setCameraDraft(undefined)
    setDrawing([])
  }

  useEffect(() => {
    const element = stage.current
    if (!element) return
    function wheel(event: WheelEvent) {
      if (play || isEditor(event.target) || event.target instanceof Element && event.target.closest('[data-card-scroll]')) return
      event.preventDefault()
      if (gesture.current?.kind === 'rotate' || gesture.current?.kind === 'resize') return
      const amount = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      setCamera(zoomAt(viewingCamera, localPoint(event), viewingCamera.zoom * Math.exp(-amount * .0018)))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [project, play, viewingCamera, canEdit])

  async function saveNow() { await flush(project.id) }
  function zoom(scale: number) { setCamera(zoomAt(viewingCamera, { x: size.width / 2, y: size.height / 2 }, scale)) }
  function fit(selection = false) {
    const objects = selection ? chosen : indexed.visible
    if (objects.length && size.width) setCamera(fitViewport(objects.map(object => object.collapsed ? { ...object, height: 36 } : object), size, { padding: 75 }))
  }

  useEffect(() => {
    const onBlur = () => {
      space.current = false
      touches.current.clear()
      tappedTool.current = undefined
      if (pinch.current || gesture.current) { pinch.current = undefined; finish(false) }
    }
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditor(event.target) || modal || files || editing || editingBack || document.querySelector('dialog[open]')) return
      const key = event.key.toLowerCase()
      if (play) {
        if (key === 'escape') { event.preventDefault(); setPlay(undefined) }
        if (key === 'arrowright' || key === 'arrowleft') {
          event.preventDefault()
          changeStop(key === 'arrowright' ? 1 : -1)
        }
        return
      }
      if (event.ctrlKey || event.metaKey) {
        if (key === 's' && canEdit) { event.preventDefault(); if (event.shiftKey) show('copy'); else void saveNow().catch(onError) }
        if ((key === 'z' || key === 'y') && canEdit) { event.preventDefault(); step(key === 'y' || event.shiftKey ? 'redo' : 'undo') }
        if (key === 'f') { event.preventDefault(); setQuery(''); setFindScope('canvas'); show('find') }
        return
      }
      if (key === ' ') { event.preventDefault(); space.current = true }
      if (key === 'escape' && (gesture.current?.kind === 'rotate' || gesture.current?.kind === 'resize' || gesture.current?.kind === 'move')) {
        event.preventDefault()
        finish(false)
        return
      }
      if (key === 'escape' && rotateTarget) { event.preventDefault(); setRotateId(undefined); return }
      if (key === 'escape') { setPopup(null); setPileMenu(undefined); setContextPoint(undefined); setSelected([]); setFromId(''); setEdgeId(''); setTool('select') }
      if (canEdit && (key === 'delete' || key === 'backspace')) { event.preventDefault(); removeSelection() }
      if (canEdit && key.startsWith('arrow') && chosen.length) {
        event.preventDefault()
        const delta = event.shiftKey ? 10 : 1
        const ids = expandSelection(chosen.filter(validForEdit).map(item => item.id))
        if (!canTransform(ids)) return
        const dx = key === 'arrowright' ? delta : key === 'arrowleft' ? -delta : 0
        const dy = key === 'arrowdown' ? delta : key === 'arrowup' ? -delta : 0
        edit(project.objects.map(item => ids.has(item.id) ? translateObject(item, dx, dy) : item))
      }
    }
    const keyup = (event: KeyboardEvent) => { if (event.key === ' ') space.current = false }
    addEventListener('keydown', keydown); addEventListener('keyup', keyup); addEventListener('blur', onBlur)
    return () => { removeEventListener('keydown', keydown); removeEventListener('keyup', keyup); removeEventListener('blur', onBlur) }
  })

  function changeStop(delta: number) {
    setPlay(current => {
      if (!current) return current
      const length = project.stops.length
      return { ...current, index: current.loop ? (current.index + delta + length) % length : Math.max(0, Math.min(length - 1, current.index + delta)) }
    })
  }
  useEffect(() => {
    if (!play?.automatic || (!play.loop && play.index === project.stops.length - 1)) return
    const timer = setTimeout(() => changeStop(1), (project.stops[play.index]?.duration ?? 5) * 1000)
    return () => clearTimeout(timer)
  }, [play, project.stops])
  useEffect(() => {
    const check = () => { if (!document.fullscreenElement) setPlay(undefined) }
    document.addEventListener('fullscreenchange', check)
    return () => document.removeEventListener('fullscreenchange', check)
  }, [])
  useEffect(() => {
    if (!play && document.fullscreenElement?.classList.contains('ic-workspace')) void document.exitFullscreen().catch(() => {})
  }, [play])

  async function addFiles(replace = '', side: CardSide = 'front') {
    if (!canEdit) return
    const object = replace ? indexed.map.get(replace) : undefined
    const existingLink = object ? (side === 'back' ? object.back?.smartlink : object.smartlink) : undefined
    if (existingLink && !window.confirm(`Replace the ${side} face Smartlink with a local attachment? Undo restores the link.`)) return
    setPopup(null)
    setReplaceId(replace)
    setReplaceSide(side)
    try {
      const chosenFiles = await pickCanvasFiles(!replace)
      if (chosenFiles === undefined) {
        if (fileInput.current) {
          fileInput.current.multiple = !replace
          fileInput.current.click()
        }
      } else if (chosenFiles.length) setFiles(chosenFiles)
    } catch (reason) { onError(reason) }
  }

  async function importAssets(assets: CanvasPreparedAsset[]) {
    if (!assets.length) return
    if (replaceId && replaceSide === 'back') {
      const object = indexed.map.get(replaceId)
      if (!object || !validForEdit(object) || !canFlip(object) || assets.length !== 1) throw new Error('Choose one attachment for an editable card.')
      if (object.back?.imageEdits && !assets[0].mime.startsWith('image/')) throw new Error('Choose an image to keep these edits, or reset the Back image edits before replacing it.')
      if (object.back?.audioAppearance && !assets[0].mime.startsWith('audio/')) throw new Error('Choose audio to keep this appearance, or reset the Back audio appearance before replacing it.')
      const { smartlink: _oldSmartlink, ...backFields } = cardFace(object, 'back')
      const back = { ...backFields, assetId: assets[0].id }
      const next = { ...project, objects: project.objects.map(item => item.id === replaceId ? { ...item, back } : item), updatedAt: Date.now() }
      await write([next], assets)
      record(next)
      return
    }
    const begin = screenToWorld(pointer.current.x ? pointer.current : { x: size.width * .47, y: size.height * .43 }, camera)
    const origin = placement === 'smart' ? placePoint(begin, placement) : begin
    if (replaceId && indexed.map.get(replaceId)?.imageEdits && !assets[0].mime.startsWith('image/')) throw new Error('Choose an image to keep these edits.')
    const edited = replaceId ? project.objects.map(object => {
      if (object.id !== replaceId) return object
      const { smartlink: _oldSmartlink, ...objectFields } = object
      return { ...objectFields, ...(object.kind === 'smartlink' ? { kind: shapeForAsset(assets[0]) } : {}), assetId: assets[0].id,
        imageEdits: undefined, audioAppearance: undefined }
    }) : project.objects
    const added: CanvasObject[] = []
    if (!replaceId) {
      let index = 0
      for (const asset of assets) {
        const kind = shapeForAsset(asset)
        const position = placement === 'smart' ? { x: origin.x + (index % 3) * 306, y: origin.y + Math.floor(index / 3) * 180 } :
          { x: origin.x + index * 24, y: origin.y + index * 16 }
        const object = makeObject(kind, position, { name: asset.name, assetId: asset.id })
        if (kind === 'image' && asset.dimensions) {
          const { width, height } = asset.dimensions
          const scale = Math.min(260 / width, 160 / height)
          object.width = Math.max(1, width * scale)
          object.height = Math.max(1, height * scale)
        }
        if (placement === 'smart') while ([...project.objects, ...added].some(item => item.kind !== 'frame' && !item.hidden && intersects(item, object))) object.y += 180
        added.push(object)
        index++
      }
    } else {
      const replaced = edited.find(object => object.id === replaceId)
      const original = project.objects.find(object => object.id === replaceId)
      const originalAsset = original?.kind === 'file' && original.assetId ? await getAsset(original.assetId) : undefined
      const fileWithAudio = replaced?.kind === 'file' && assets[0].mime.startsWith('audio/') && (replaced.audioAppearance || originalAsset?.mime.startsWith('audio/'))
      if (assets.length !== 1 || !replaced || (replaced.kind !== 'smartlink' && !fileWithAudio && shapeForAsset(assets[0]) !== replaced.kind)) throw new Error('Choose one matching media file.')
    }
    const changes = new Map<string, CanvasObject>()
    const frame = frameAt(begin)
    if (frame) for (const object of added) { object.parentId = frame.id; growFrames(object, changes) }
    await write([{ ...project, objects: [...edited.map(item => changes.get(item.id) ?? item), ...added], updatedAt: Date.now() }], assets)
    setSelected(replaceId ? [replaceId] : added.map(object => object.id))
  }

  function previewObject(object: CanvasObject) { setPreview(object); show('preview') }
  function openObject(object: CanvasObject) {
    if (object.kind === 'canvas' && object.targetId) openCanvas(object.targetId)
    else if (object.kind === 'page' && object.targetId) openPage(object.targetId)
    else if (validForEdit(object) && cardSide(object) === 'back') setEditingBack(object.id)
    else if ((object.kind === 'text' || object.kind === 'note') && validForEdit(object)) setEditing(indexed.map.get(object.id) ?? object)
  }

  async function moveProject() {
    const parentId = moveTarget || null
    if (parentId === project.parentId) { setModal(null); return }
    const oldParent = projects.find(item => item.id === project.parentId)
    const newParent = projects.find(item => item.id === parentId)
    const batch = [{ ...project, parentId, updatedAt: Date.now() }]
    if (oldParent) {
      const removed = new Set(oldParent.objects.filter(item => item.kind === 'canvas' && item.targetId === project.id && !item.referenceOnly).map(item => item.id))
      batch.push({ ...oldParent, objects: oldParent.objects.filter(item => !removed.has(item.id)),
        edges: oldParent.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to)), updatedAt: Date.now() })
    }
    if (newParent) {
      const x = newParent.objects.length ? Math.max(...newParent.objects.map(item => item.x + item.width)) + 32 : 52
      const tile = makeObject('canvas', { x, y: 65 }, { name: project.name, targetId: project.id })
      batch.push({ ...newParent, objects: [...newParent.objects, tile], updatedAt: Date.now() })
    }
    try { await write(batch); setModal(null); resetHistory() } catch (reason) { onError(reason) }
  }

  const saveModes = ['versions', 'checkpoint', 'recovery', 'copy'] as const
  const findProjects = (findScope === 'all' ? projects : findScope === 'children' ? [project, ...descendants(projects, project.id)] : [project])
    .filter(item => !ancestors(projects, item.id).some(ancestor => ancestor.trashedAt))
  const matches = query.trim() ? findProjects.flatMap(canvas => searchCanvasObjects(canvas, query, findKind)
    .map(match => ({ canvas, ...match }))).slice(0, 100) : []
  const backBeingEdited = editingBack ? indexed.map.get(editingBack) : undefined
  const pendingDelete = stackToDelete ? indexed.map.get(stackToDelete) : undefined
  const selectedStack = chosen.length === 1 && chosen[0].kind === 'stack' ? chosen[0] : undefined
  const stackingSelection = chosen.length > 1 && chosen.every(canFlip)
  const stackable = stackingSelection && canStackCards(project.objects, selected)
  const stackHint = stackable ? undefined : 'Select unlocked, loose cards in the same container'
  const selectedMember = chosen.length === 1 && indexed.map.get(chosen[0].parentId ?? '')?.kind === 'stack'
  const quickOffset = (rotateTarget ? 59 : 42) + (selectedMember ? 36 : 0)
  const activeMove = gesture.current?.kind === 'move' ? gesture.current : undefined
  const stackCandidates = activeMove && dragged.length ? movingCardIds(activeMove) : []
  const pileUIs = [...displayedPiles.piles.values()].flatMap(pile => {
    if (indexed.flags.get(pile.stack.id)?.hidden || !pile.frontId) return []
    const card = displayedPiles.cards.get(pile.frontId)
    if (!card) return []
    const bounds = rotatedBounds(card, card.rotation)
    const point = worldToScreen({ x: bounds.right, y: bounds.top }, camera)
    if (point.x < -60 || point.x > size.width + 90 || point.y < -60 || point.y > size.height + 90) return []
    return [{ pile, card, bounds, point }]
  })
  const activeSettings = play ? stageProject.settings : settings
  const menuButtons = (items: ReturnType<typeof action>[]) => items.map(item => <button key={item.label} onClick={item.run}>{item.icon}{item.label}</button>)
  const tools = [{ id: 'select', name: 'Select', icon: MousePointer2 }, { id: 'hand', name: 'Hand', icon: Hand },
    { id: 'text', name: 'Text', icon: Type }, { id: 'note', name: 'Sticky note', icon: StickyNote }, { id: 'stroke', name: 'Draw', icon: PenLine }] as const
  const currentColour = chosen.length === 1 && chosen[0].mode === 'card' ? chosen[0].colour : undefined
  const textSelection = singleSelection && (singleSelection.kind === 'text' || singleSelection.kind === 'note' ||
    cardSide(singleSelection) === 'back') ? singleSelection : undefined
  const alignment = textSelection?.textAlign ?? 'left'
  const quickWidth = (rotateTarget ? 255 : 225) + (textSelection ? 104 : 0) + (imageKey ? 98 : 0)
  const showQuick = canEdit && !selectedStack && !!quick && !play && !dragged.length && !marquee && chosen.some(item => renderedIds.has(item.id) || item.kind === 'group')
  const quickLeft = Math.max(8, Math.min(size.width - quickWidth, quick?.x ?? 0))
  let quickTop = quick ? selectedMember && quick.y - quickOffset < 58 ? Math.max(94, quick.y + 14) : Math.max(58, quick.y - quickOffset) : 58
  if (showQuick && quick) {
    const toolbarHeight = size.width < 370 && imageKey && textSelection ? 72 : 40
    for (const frame of rendered) {
      if (frame.kind !== 'frame' || selected.includes(frame.id)) continue
      const labelRect = { x: frame.x, y: frame.y, width: frame.collapsed ? frame.width : Math.min(frame.width, frame.name.length * 8 + 36), height: 36, rotation: 0 }
      const labelFrame = frame.collapsed ? { ...frame, height: 36 } : frame
      const rotatedLabel = transformDescendant(labelRect, { ...labelFrame, rotation: 0 }, labelFrame, 1)
      const label = rotatedBounds(rotatedLabel, rotatedLabel.rotation)
      const start = worldToScreen({ x: label.left, y: label.top }, camera)
      const end = worldToScreen({ x: label.right, y: label.bottom }, camera)
      if (quickLeft < end.x && quickLeft + quickWidth > start.x && quickTop < end.y && quickTop + toolbarHeight > start.y) {
        quickTop = start.y - toolbarHeight - 4 >= 58 ? start.y - toolbarHeight - 4 : Math.min(size.height - toolbarHeight - 8, end.y + 4)
      }
    }
  }
  const imageInspector = image && imageKey && singleSelection ? <ImageTools key={imageKey} assetId={image}
    {...imageFrameSize(singleSelection, imageSide)} edits={cardFace(singleSelection).imageEdits}
    sectionRequest={imageSection?.key === imageKey ? imageSection : undefined}
    disabled={!validForEdit(singleSelection)} swatches={project.swatches ?? []}
    onPreview={edits => setImageDraft(edits ? { key: imageKey, edits } : undefined)}
    onCommit={edits => commitImageEdits(singleSelection.id, imageSide, image, edits)}
    onCompare={active => setCompareImage(active ? imageKey : undefined)}
    onSwatches={swatches => { if (canEdit && validForEdit(singleSelection)) editSwatches(swatches) }}
    onRelink={() => void addFiles(singleSelection.id, imageSide)} /> : undefined
  const mediaInspector = audio && singleSelection ? <AudioProperties key={`${singleSelection.id}/${imageSide}/${audio}`}
    appearance={selectedFace?.audioAppearance} dark={dark} disabled={!validForEdit(singleSelection)} swatches={project.swatches}
    change={appearance => commitAudioAppearance(singleSelection.id, imageSide, audio, appearance)} /> : imageInspector

  return <section className="ic-workspace" data-presentation={!!play}>
    {!play && <header className="ic-header">
      {!sidebarOpen && <button ref={sidebarToggleRef} className="ic-icon" aria-label="Open sidebar" onClick={toggleSidebar}><PanelLeft /></button>}
      <nav className="ic-breadcrumbs" aria-label="Canvas breadcrumbs"><button onClick={goHome}>Home</button>
        {chain.map(item => <span key={item.id}><ChevronRight size={13} /><button title={item.name} aria-current={item.id === project.id ? 'page' : undefined}
          onClick={() => item.id === project.id ? canEdit && show('details') : openCanvas(item.id)}><ProjectIcon project={item} /><span className="ic-breadcrumb-label">{item.name}</span></button></span>)}
      </nav>
      <div className="ic-header-actions">
        <button className="ic-icon" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={() => step('undo')}><Undo2 /></button>
        <button className="ic-icon" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={() => step('redo')}><Redo2 /></button>
        <div className="ic-anchor"><button className="ic-button" aria-label="View" aria-expanded={popup === 'view'} onClick={() => toggle('view')}><Eye /> <span>View</span></button>
          {popup === 'view' && <div className="ic-menu ic-menu-right">
            {(['dots', 'lines', 'none'] as const).map(grid => <button key={grid} aria-pressed={settings.grid === grid}
              onClick={() => updateSettings({ grid })}>{grid[0].toUpperCase() + grid.slice(1)}</button>)}
            <hr />
            <label><input type="checkbox" checked={settings.minimap} onChange={event => updateSettings({ minimap: event.target.checked })} /> Minimap</label>
            {(Object.keys(edgeLabels) as EdgeKind[]).map(kind => <label key={kind}><input type="checkbox" checked={settings.showEdges[kind]}
              onChange={event => updateSettings({ showEdges: { ...settings.showEdges, [kind]: event.target.checked } })} /> {edgeLabels[kind]}</label>)}
            {canEdit && <button onClick={() => { updateSettings({ panel: settings.panel === 'closed' ? 'layers' : 'closed' }); setPopup(null) }}><Layers /> {settings.panel === 'closed' ? 'Show inspector' : 'Hide inspector'}</button>}
          </div>}
        </div>
        {(canEdit || project.stops.length > 0) && <button className="ic-icon" aria-label="Presentation" title="Presentation"
          onClick={canEdit ? () => show('presentation') : () => startPresentation()}><Play /></button>}
        {canEdit && <div className="ic-anchor"><span className="sr-only" role="status">{status}</span><button className="ic-button" aria-label="Save menu" aria-expanded={popup === 'save'} onClick={() => toggle('save')}><Save /> <span>{status}</span><ChevronDown size={12} /></button>
          {popup === 'save' && <div className="ic-menu ic-menu-right">{menuButtons([
            action('Save', () => { setPopup(null); void saveNow().catch(onError) }), action('Save VC', () => show('checkpoint')), action('Save As…', () => show('copy')),
          ])}</div>}
        </div>}
        <div className="ic-anchor"><button className="ic-icon" title="Project menu" aria-label="Project menu" aria-expanded={popup === 'project'} onClick={() => toggle('project')}><MoreHorizontal /></button>
          {popup === 'project' && <div className="ic-menu ic-menu-right">{menuButtons([
            ...canEdit ? [action('Project Details', () => show('details')),
              action('Move project…', () => { setMoveTarget(project.parentId ?? ''); show('move') }),
              action('Move to Trash…', () => show('trash'), <Trash2 />),
              action('Version History', () => show('versions')), action('Recovery snapshots', () => show('recovery'))] : [],
            action('Find in canvas', () => show('find'), <Search />),
            action('Export', () => show('export'), <ArrowDownToLine />),
          ])}</div>}
        </div>
      </div>
    </header>}
    <input ref={fileInput} type="file" hidden multiple onChange={event => {
      const picked = [...(event.currentTarget.files ?? [])].map(file => ({ file }))
      event.currentTarget.value = ''
      if (picked.length) setFiles(picked)
    }} />
    <div className="ic-stage" ref={stage} role="region" aria-label="Canvas" data-tool={tool} data-dragover={dropActive} data-rotating={rotating}
      style={{ '--ic-grid-size': gridSize + 'px', '--ic-grid-x': camera.x % gridSize + 'px', '--ic-grid-y': camera.y % gridSize + 'px' } as CSSProperties}
      data-grid={activeSettings.grid} onPointerDownCapture={trackTouch} onPointerDown={event => start(event)} onPointerMove={move} onPaste={pasteSmartlink}
      onPointerUp={event => endPointer(event)} onPointerCancel={event => endPointer(event, false)}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (canEdit) setDropActive(true) } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false) }}
      onDrop={event => {
        event.preventDefault()
        setDropActive(false)
        if (play || !canEdit) return
        pointer.current = localPoint(event)
        setReplaceId('')
        setReplaceSide('front')
        void droppedCanvasFiles(event.dataTransfer).then(items => { if (items.length) setFiles(items) }).catch(onError)
      }}>
      <div className={'ic-world' + (play?.smooth && origin.x === 0 && origin.y === 0 ? ' ic-smooth' : '')} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${camera.zoom})` }}>
        {pileUIs.flatMap(({ pile }) => [...pile.rear].reverse().map(({ memberId, rect, colour }) => {
          const member = indexed.map.get(memberId)
          if (play || !member) return <div key={memberId} className="ic-stack-rear" aria-hidden="true" style={{ left: rect.x - origin.x, top: rect.y - origin.y,
            width: rect.width, height: rect.height, transform: `rotate(${rect.rotation}deg)`, '--ic-rear-colour': colour } as CSSProperties} />
          return <button key={memberId} type="button" className="ic-stack-rear" title={'Bring forward · ' + member.name}
            aria-label={'Bring forward ' + member.name} style={{ left: rect.x - origin.x, top: rect.y - origin.y,
              width: rect.width, height: rect.height, transform: `rotate(${rect.rotation}deg)`, '--ic-rear-colour': colour } as CSSProperties}
            onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={() => revealCard(member)} />
        }))}
        {rendered.map(object => {
          const target = object.targetId ? projects.find(candidate => candidate.id === object.targetId &&
            !ancestors(projects, candidate.id).some(ancestor => ancestor.trashedAt)) : undefined
          const picked = !play && selected.includes(object.id)
          const locked = indexed.flags.get(object.id)?.locked
          const card = object.mode === 'card'
          const isBack = cardSide(object) === 'back'
          const faceSmartlink = isBack ? object.back?.smartlink : object.smartlink
          const isMember = !!object.parentId && !!indexed.map.get(object.parentId)?.stack
          const audioFace = object.kind === 'audio' && !isBack || !!cardFace(object).audioAppearance
          const atThumbnailScale = Math.max(object.width, object.height) * camera.zoom < (audioFace ? 52 : 18) && !picked
          const mediaAsset = imageAssetId(object)
          const mediaKey = !play && mediaAsset ? `${object.id}/${cardSide(object)}/${mediaAsset}` : undefined
          return <div key={object.id} className="ic-item" data-kind={object.kind} data-mode={object.mode} data-selected={picked}
            data-card-side={canFlip(object) ? cardSide(object) : undefined} data-stack-member={isMember || undefined}
            data-collapsed={!!object.collapsed} data-border={!!object.border} data-from={fromId === object.id}
            style={{ left: object.x - origin.x, top: object.y - origin.y, width: object.width, height: object.collapsed ? 36 : object.height,
              transform: `rotate(${object.rotation}deg)`, opacity: object.opacity, '--ic-item-colour': object.colour,
              '--ic-item-ink': card || isBack || isMember ? readableInk(object.colour) : undefined } as CSSProperties}
            onPointerDown={event => { event.stopPropagation(); start(event, object) }}
            onDoubleClick={event => { event.stopPropagation(); if (!play) openObject(object) }}
            tabIndex={!play ? 0 : undefined}
            onKeyDown={event => {
              if (!play && event.key === 'Enter' && event.target === event.currentTarget) {
                event.preventDefault()
                event.stopPropagation()
                pick(object.id)
                openObject(object)
              }
            }}
            onContextMenu={event => { if (!play && canEdit) {
              event.preventDefault()
              if (!selected.includes(object.id)) pick(object.id)
              setContextPoint(localPoint(event))
            } }}
            data-testid={'canvas-object-' + object.id} aria-label={object.name}>
            {atThumbnailScale ? <div className={audioFace ? 'ic-item-swatch ic-audio-swatch' : 'ic-item-swatch'}>{audioFace && <AudioLines aria-hidden="true" />}</div> : object.kind === 'frame' ? <span className="ic-frame-label"><Box size={14} /> {object.name}{object.collapsed && <small>{project.objects.filter(item => item.parentId === object.id).length} items</small>}</span> : <>
              {faceSmartlink ? <span className="ic-smartlink-grab"><GripHorizontal size={13} />{object.name}</span> :
                !isBack && card && !['canvas', 'page', 'file', 'note'].includes(object.kind) && <span className="ic-object-title">{object.name}</span>}
              <ObjectContent object={object} target={target} reloadMedia={object.assetId} canRelink={canEdit && !locked} dark={dark} previewScale={previewScale}
                replace={() => void addFiles(object.id)} replaceBack={() => void addFiles(object.id, 'back')}
                activeSmartlink={activeSmartlinkIds.has(object.id)} smartlinkCanPlay={object.width * camera.zoom >= 240 && object.height * camera.zoom >= (isBack ? 420 : 340)}
                canEdit={canEdit && !locked} onSmartlinkMode={changeSmartlinkMode} onSmartlinkEdit={openSmartlinkEditor}
                onSmartlinkPrivacy={openPrivacy} zoomToPlay={item => setCamera(fitViewport([item], size, { padding: 72, max: 2.3 }))}
                imageDraft={mediaKey && mediaKey === imageKey && imageDraft?.key === mediaKey ? imageDraft.edits : undefined}
                compareImage={!!mediaKey && mediaKey === imageKey && compareImage === mediaKey} />
              {!isBack && card && object.caption && <small className="ic-caption">{object.caption}</small>}
            </>}
            {!play && !atThumbnailScale && canFlip(object) && <CardFlipControl object={object} flipCard={flipCard} />}
            {canEdit && picked && !locked && !rotateTarget && !isMember &&
              <button className="ic-handle ic-resize" tabIndex={-1} aria-label={'Resize ' + object.name}
                onPointerDown={event => { event.stopPropagation(); start(event, object, 'resize') }} />}
          </div>
        })}
        {selectedGroup && <div className="ic-item ic-group-outline" data-selected="true"
          style={{ left: selectedGroup.x - origin.x, top: selectedGroup.y - origin.y, width: selectedGroup.width,
            height: selectedGroup.height, transform: `rotate(${selectedGroup.rotation}deg)` }}>
          {validForEdit(selectedGroup) && !rotateTarget &&
            <button className="ic-handle ic-resize" tabIndex={-1} aria-label={'Resize ' + selectedGroup.name}
              onPointerDown={event => { event.stopPropagation(); start(event, selectedGroup, 'resize') }} />}
        </div>}
        <svg className="ic-edge-layer" width="1" height="1" aria-label="Canvas connections">
          <defs><marker id="ic-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke" /></marker></defs>
          {stageProject.edges.map(edge => {
            const from = dragMap.get(edge.from) ?? indexed.map.get(edge.from)
            const to = dragMap.get(edge.to) ?? indexed.map.get(edge.to)
            if (!activeSettings.showEdges[edge.kind] || !from || !to || indexed.flags.get(from.id)?.hidden || indexed.flags.get(to.id)?.hidden) return null
            const raw = connectionEndpoints(displayedPiles.proxies.get(from.id) ?? from, displayedPiles.proxies.get(to.id) ?? to)
            if (!intersects({ x: Math.min(raw.from.x, raw.to.x), y: Math.min(raw.from.y, raw.to.y),
              width: Math.abs(raw.from.x - raw.to.x), height: Math.abs(raw.from.y - raw.to.y) },
            { ...topLeft, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y })) return null
            const ends = { from: { x: raw.from.x - origin.x, y: raw.from.y - origin.y }, to: { x: raw.to.x - origin.x, y: raw.to.y - origin.y } }
            return <g key={edge.id} data-edge-kind={edge.kind} onPointerDown={event => {
              if (!play) { event.stopPropagation(); setEdgeId(edge.id); setSelected([]) }
            }}>
              <line className="ic-edge-hit" x1={ends.from.x} y1={ends.from.y} x2={ends.to.x} y2={ends.to.y} stroke="transparent" strokeWidth={14 / camera.zoom} />
              <line x1={ends.from.x} y1={ends.from.y} x2={ends.to.x} y2={ends.to.y} stroke={edge.colour ?? colourForEdge[edge.kind]}
                strokeWidth={edge.id === edgeId ? 3 : 2} strokeDasharray={edge.kind === 'relationship' ? '5 5' : undefined} markerEnd={edge.kind === 'direction' ? 'url(#ic-arrow)' : undefined} />
              {edge.label && <text x={(ends.from.x + ends.to.x) / 2} y={(ends.from.y + ends.to.y) / 2 - 7} textAnchor="middle">{edge.label}</text>}
            </g>
          })}
          {drawing.length > 1 && <polyline points={drawing.map(point => `${point.x - origin.x},${point.y - origin.y}`).join(' ')} fill="none" stroke={palette[6]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </div>
      {!play && pileUIs.map(({ pile, card, bounds, point }) => {
        const fanned = pile.stack.stack?.layout === 'fan'
        const x = Math.min(size.width - 58, Math.max(58, point.x - 45))
        const y = Math.min(size.height - 38, Math.max(64, point.y - 15))
        const addable = stackCandidates.length > 0 && canAddToStack(project.objects, pile.stack.id, stackCandidates)
        const accessiblePosition = { left: x, top: y }
        return <div key={pile.stack.id} className="ic-pile-tools" data-stack-id={pile.stack.id}>
          {selectedStack?.id === pile.stack.id && <div className="ic-stack-selected" aria-hidden="true" style={{
            left: worldToScreen({ x: bounds.left, y: bounds.top }, camera).x - 4, top: point.y - 4,
            width: (bounds.right - bounds.left) * camera.zoom + 8, height: (bounds.bottom - bounds.top) * camera.zoom + 8 }} />}
          {addable && <div className="ic-stack-drop" data-add-to-stack={pile.stack.id} data-active={stackDrop === pile.stack.id}
            style={{ ...accessiblePosition, transform: 'translate(-50%, -50%)' }}>Add to Stack</div>}
          {!dragged.length && <div className="ic-stack-controls" data-anchor="center" style={accessiblePosition}
            onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }}>
            {canEdit && <button type="button" className="ic-icon ic-stack-handle" title="Drag to move stack" aria-label={'Move stack ' + pile.stack.name}
              disabled={!validForEdit(pile.stack)} onPointerDown={event => startPileDrag(event, pile.stack)}
              onClick={() => pick(pile.stack.id)}><GripHorizontal /></button>}
            <button type="button" className="ic-stack-count" aria-expanded={pileMenu === pile.stack.id} aria-label={`Browse ${pile.order.length} ${pile.order.length === 1 ? 'card' : 'cards'} in ${pile.stack.name}`}
              onClick={() => { setPileMenu(current => current === pile.stack.id ? undefined : pile.stack.id); pick(pile.stack.id) }}>
              {pile.order.length} {pile.order.length === 1 ? 'card' : 'cards'}</button>
            {canEdit && <button type="button" className="ic-icon ic-stack-extract" title="Drag to pull out the front card" aria-label={'Extract ' + card.name}
              disabled={!validForEdit(card)} onPointerDown={event => startPileDrag(event, card, true)}
              onClick={event => { if (event.detail === 0) removeFromStack(card); else revealCard(card) }}><ArrowDownToLine /></button>}
          </div>}
          {pileMenu === pile.stack.id && !dragged.length && <div className="ic-stack-member-popover" data-card-scroll=""
            aria-label={pile.stack.name + ' members'} style={{ left: Math.max(6, Math.min(size.width - 224, x - 70)), top: Math.min(size.height - 250, y + 18) }}
            onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }}>
            {pile.order.map(id => {
              const member = indexed.map.get(id)
              return member && <button type="button" key={id} aria-current={id === pile.frontId}
                disabled={!!indexed.flags.get(id)?.hidden} onClick={() => { revealCard(member); setPileMenu(undefined) }}>{member.name}</button>
            })}
            <button type="button" disabled={!!indexed.flags.get(pile.stack.id)?.locked}
              onClick={() => { changeStackLayout(pile.stack, !fanned); setPileMenu(undefined) }}>{fanned ? 'Restack' : 'Fan Out'}</button>
            {canEdit && <>
              <button type="button" disabled={!validForEdit(pile.stack)} onClick={() => { stackAction(() => unstackAll(project.objects, pile.stack.id), card.id); setPileMenu(undefined) }}>Unstack All</button>
              <button type="button" disabled={!validForEdit(pile.stack)} onClick={() => { setStackToDelete(pile.stack.id); show('deleteStack'); setPileMenu(undefined) }}>Delete stack…</button>
            </>}
          </div>}
        </div>
      })}
      {rotateTarget && rotationPosition && <div className="ic-rotation-outline"
        style={{ left: rotationPosition.x, top: rotationPosition.y, width: rotateTarget.width * camera.zoom,
          height: rotateTarget.height * camera.zoom, transform: `translate(-50%, -50%) rotate(${rotateTarget.rotation}deg)` }}>
        {rotationEdges.map(edge => <button key={edge} type="button" className="ic-rotation-edge" data-rotate-edge={edge} tabIndex={-1}
          aria-label={'Drag ' + edge + ' edge to rotate'} onPointerDown={event => startRotation(event, chosen[0])} />)}
      </div>}
      {rotateTarget && rotationPosition && <output className="ic-rotation-angle" aria-label="Rotation angle"
        style={{ left: Math.max(23, Math.min(size.width - 23, rotationPosition.x)), top: Math.max(12, Math.min(size.height - 20, rotationPosition.y)) }}>
        {Number(rotateTarget.rotation.toFixed(1))}°
      </output>}
      {marquee && <div className="ic-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      {guides?.x !== undefined && <div className="ic-guide ic-guide-x" style={{ left: guides.x }} />}
      {guides?.y !== undefined && <div className="ic-guide ic-guide-y" style={{ top: guides.y }} />}
      {!play && <>
        {canEdit && !project.objects.length && !dropActive && <div className="ic-empty"><Layers size={26} /><h2>Start with an idea</h2><p>Drop files here or choose a tool to add something.</p>
          <button className="ic-button" onPointerDown={event => event.stopPropagation()} onClick={() => void addFiles()}><Plus /> Add files</button></div>}
        {dropActive && <div className="ic-drop-target">Drop files to add them to this canvas</div>}
        {canEdit && <div className="ic-toolbar" ref={toolbar} data-mode={project.settings.toolbar}
          style={project.settings.toolbar === 'floating' ? {
            left: `${(toolbarDraft ?? project.settings.toolbarPoint).x * 100}%`, top: `${(toolbarDraft ?? project.settings.toolbarPoint).y * 100}%`,
          } : undefined} onPointerDown={event => event.stopPropagation()}>
          {project.settings.toolbar === 'floating' && <button className="ic-icon ic-toolbar-grip" aria-label="Drag toolbar" title="Drag toolbar"
            onPointerDown={event => {
              const target = event.currentTarget
              const rect = stage.current?.getBoundingClientRect()
              if (!rect || !toolbar.current) return
              const initial = localPoint(event)
              const original = project.settings.toolbarPoint
              let last = original
              const margin = Math.min(.49, toolbar.current.offsetWidth / rect.width / 2)
              target.setPointerCapture(event.pointerId)
              const onMove = (pointerEvent: PointerEvent) => {
                const next = localPoint(pointerEvent)
                last = { x: Math.max(margin, Math.min(1 - margin, original.x + (next.x - initial.x) / rect.width)),
                  y: Math.max(.005, Math.min(.91, original.y + (next.y - initial.y) / rect.height)) }
                setToolbarDraft(last)
              }
              const onEnd = () => {
                target.removeEventListener('pointermove', onMove)
                target.removeEventListener('pointerup', onEnd)
                target.removeEventListener('pointercancel', onEnd)
                setToolbarDraft(undefined)
                updateSettings({ toolbarPoint: last })
              }
              target.addEventListener('pointermove', onMove)
              target.addEventListener('pointerup', onEnd)
              target.addEventListener('pointercancel', onEnd)
            }}>⠿</button>}
          {tools.map(({ id, name, icon: Icon }) => <button key={id} className="ic-icon" title={name} aria-label={name} aria-pressed={tool === id}
            onClick={() => chooseTool(id)}><Icon /></button>)}
          <div className="ic-anchor"><button className="ic-icon" title="Shapes" aria-label="Shapes" aria-expanded={popup === 'shapes'} onClick={() => toggle('shapes')}><Square /></button>
            {popup === 'shapes' && <div className="ic-menu">{menuButtons([
              action('Rectangle', () => chooseTool('rectangle'), <Square />),
              action('Ellipse', () => chooseTool('ellipse'), <Circle />),
              action('Frame', () => chooseTool('frame'), <Box />),
            ])}</div>}
          </div>
          <div className="ic-anchor"><button className="ic-icon" title="Connections" aria-label="Connections" aria-expanded={popup === 'edges'} onClick={() => toggle('edges')}><ArrowRight /></button>
            {popup === 'edges' && <div className="ic-menu">{menuButtons((Object.keys(edgeLabels) as EdgeKind[]).map(kind =>
              action(kind[0].toUpperCase() + kind.slice(1), () => { setTool(kind); setFromId(''); setPopup(null); setFeedback('Select the source object.') })))}</div>}
          </div>
          <div className="ic-anchor"><button className="ic-icon" title="Add" aria-label="Add to canvas" aria-expanded={popup === 'add'} onClick={() => toggle('add')}><Plus /></button>
            {popup === 'add' && <div className="ic-menu">{menuButtons([
              action('Add files', () => void addFiles(), <Image />), action('New SubCanvas', () => show('subcanvas'), <Layers />),
              action('Link existing canvas', () => show('link'), <Layers />),
              action('Smartlink', () => openSmartlinkEditor(undefined, 'front', lastCanvasPointer.current), <Link2 />),
              action('Embed Croft page', () => show('embed'), <FileText />),
            ])}</div>}
          </div>
          <div className="ic-anchor"><button className="ic-icon" title="Toolbar options" aria-label="Toolbar options" aria-expanded={popup === 'tools'} onClick={() => toggle('tools')}><MoreHorizontal /></button>
            {popup === 'tools' && <div className="ic-menu ic-menu-right">
              <button onClick={() => { updateSettings({ toolbar: project.settings.toolbar === 'floating' ? 'parked' : 'floating' }); setPopup(null) }}>
                {project.settings.toolbar === 'floating' ? 'Park toolbar' : 'Float toolbar'}</button>
              <hr />
              {([['snapGrid', 'Snap to Grid'], ['snapObjects', 'Snap to Objects'], ['guides', 'Show Guides']] as const).map(([key, label]) =>
                <label key={key}><input type="checkbox" checked={project.settings[key]} onChange={event => updateSettings({ [key]: event.target.checked })} />{label}</label>)}
              <hr />
              {(['smart', 'free'] as const).map(option => <button key={option} aria-pressed={placement === option} onClick={() => {
                setPlacement(option)
                try { localStorage.setItem('croft-icanvas-placement', option) } catch { /* session preference remains */ }
              }}>{option === 'smart' ? 'Smart placement' : 'Free placement'}</button>)}
            </div>}
          </div>
        </div>}
        {showQuick && quick && <div className="ic-quick" role="toolbar" aria-label="Selection actions" onPointerDown={event => event.stopPropagation()}
          style={{ left: quickLeft, top: quickTop }}>
          {chosen.length === 1 && <>
            {['canvas', 'page'].includes(chosen[0].kind) && <button className="ic-icon" aria-label="Quick Preview" title="Quick Preview" onClick={() => previewObject(chosen[0])}><Eye /></button>}
            {chosen[0].kind === 'group' ? <button className="ic-icon" aria-label="Ungroup" title="Ungroup" onClick={() => ungroup(chosen[0])}><Unlink /></button> :
              <button className="ic-icon" aria-label={currentColour ? 'Remove Card' : 'Convert to Card'} title={currentColour ? 'Remove Card' : 'Convert to Card'}
                onClick={() => changeObject(chosen[0], { mode: currentColour ? 'direct' : 'card' })}><Box /></button>}
            <button className="ic-icon" aria-label="Rotate" title={chosen[0].collapsed ? 'Expand frame to rotate' : 'Rotate · drag an edge or use arrow keys · Alt disables snapping'}
              aria-pressed={!!rotateTarget} disabled={selectionLocked || !!chosen[0].collapsed}
              onKeyDown={event => {
                if (!rotateTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) return
                event.stopPropagation()
                if (event.key === ' ') return
                event.preventDefault()
                const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1
                const increment = event.altKey ? 1 : rotationIncrement || 1
                changeObject(chosen[0], { rotation: snapRotation(chosen[0].rotation + direction * increment, 0) })
              }}
              onClick={() => { setTool('select'); setRotateId(rotateTarget ? undefined : chosen[0].id) }}><RotateCw /></button>
            <button className="ic-icon" aria-label={selectionLocked ? 'Unlock' : 'Lock'} title={selectionLocked ? 'Unlock' : 'Lock'}
              aria-pressed={selectionLocked} disabled={selectionLocked && !chosen[0].locked}
              onClick={() => { setRotateId(undefined); changeObject(chosen[0], { locked: !chosen[0].locked }) }}>
              {selectionLocked ? <Lock /> : <LockOpen />}
            </button>
          </>}
          {stackingSelection && <button className="ic-button" disabled={!stackable} title={stackHint} onClick={stackSelection}>Stack Cards</button>}
          {chosen.length > 1 && <button className="ic-icon" aria-label="Group selection" title="Group selection" onClick={groupSelection}><Layers /></button>}
          {textSelection && <div className="ic-text-align" role="group" aria-label="Text alignment"
            onKeyDown={event => { if (event.key === ' ') event.stopPropagation() }}>
            {textAlignments.map(({ value, label, icon: Icon }) => <button key={value} type="button" className="ic-icon" title={label}
              aria-label={label} aria-pressed={alignment === value} disabled={selectionLocked}
              onClick={() => { if (alignment !== value) changeObject(textSelection, { textAlign: value === 'left' ? undefined : value }) }}><Icon /></button>)}
          </div>}
          {imageKey && <div className="ic-image-shortcuts" role="group" aria-label="Image shortcuts"
            onKeyDown={event => { if (event.key === ' ') event.stopPropagation() }}>
            {imageShortcuts.map(({ section, label, icon: Icon }) => <button key={section} type="button" className="ic-icon"
              title={label} aria-label={label} onClick={() => {
                updateSettings({ panel: 'properties' })
                setImageSection(previous => ({ key: imageKey, section, tick: (previous?.tick ?? 0) + 1 }))
              }}><Icon /></button>)}
          </div>}
          <button className="ic-icon" aria-label="Duplicate" title="Duplicate" onClick={duplicate}><Copy /></button>
          <button className="ic-icon" aria-label="Delete selected" title="Delete selected" onClick={removeSelection}><Trash2 /></button>
          {rotateTarget && <label className="ic-rotation-setting" title="Hold Alt for free rotation">
            <span>Snap</span><select aria-label="Rotation snap increment" value={rotationIncrement}
              onChange={event => setRotationIncrement(Number(event.currentTarget.value))}>
              {rotationIncrements.map(value => <option value={value} key={value}>{value ? `${value}°` : 'Off'}</option>)}
            </select>
          </label>}
        </div>}
        {contextPoint && (chosen.length === 1 || stackingSelection) && <div className="ic-menu ic-context-menu" onPointerDown={event => event.stopPropagation()}
          style={{ left: Math.max(2, Math.min(size.width - 180, contextPoint.x)), top: Math.max(2, Math.min(size.height - 106, contextPoint.y)) }}>
          {stackingSelection ? <button disabled={!stackable} title={stackHint} onClick={stackSelection}>Stack Cards</button> : <>
          {canFlip(chosen[0]) && <button onClick={() => { flipCard(chosen[0]); setContextPoint(undefined) }}>Show {cardSide(chosen[0]) === 'back' ? 'Front' : 'Back'}</button>}
          {canEdit && !['frame', 'group', 'stack'].includes(chosen[0].kind) && <button onClick={() => openSmartlinkEditor(chosen[0], cardSide(chosen[0]))}>
            {((cardSide(chosen[0]) === 'back' ? chosen[0].back?.smartlink : chosen[0].smartlink) ? 'Edit' : 'Add') + ' Smartlink on ' + (cardSide(chosen[0]) === 'back' ? 'Back' : 'Front')}
          </button>}
          {contextSmartlink && <>
            <hr />
            {([['embed', 'Embed'], ['preview', 'Preview Card'], ['link', 'Link Only']] as const).map(([mode, label]) => <button key={mode}
              disabled={!validForEdit(chosen[0]) || mode === 'embed' && contextSmartlink.provider === 'website'} aria-pressed={contextSmartlink.mode === mode}
              onClick={() => { changeSmartlinkMode(chosen[0], contextSide, mode); setContextPoint(undefined) }}>{label}</button>)}
          </>}
          {chosen[0].parentId && indexed.map.get(chosen[0].parentId)?.stack && <button onClick={() => { removeFromStack(chosen[0]); setContextPoint(undefined) }}>Remove from Stack</button>}
          <button disabled={!validForEdit(chosen[0])} onClick={() => {
            changeObject(chosen[0], { mode: chosen[0].mode === 'card' ? 'direct' : 'card' })
            setContextPoint(undefined)
          }}>{chosen[0].mode === 'card' ? 'Remove Card' : 'Convert to Card'}</button>
          <button disabled={!validForEdit(chosen[0])} onClick={() => { reorder(chosen[0].id, 'front'); setContextPoint(undefined) }}>Bring to front</button>
          <button disabled={!validForEdit(chosen[0])} onClick={() => { reorder(chosen[0].id, 'back'); setContextPoint(undefined) }}>Send to back</button>
          </>}
        </div>}
        {settings.minimap && <Minimap objects={indexed.visible} camera={camera} size={size} onCamera={setCamera} />}
        <div className="ic-zoom" onPointerDown={event => event.stopPropagation()}>
          <button className="ic-icon" aria-label="Zoom out" onClick={() => zoom(camera.zoom / 1.25)}><Minus /></button>
          <div className="ic-anchor"><button className="ic-button ic-zoom-label" aria-label="Zoom settings" aria-expanded={popup === 'zoom'} onClick={() => toggle('zoom')}>{camera.zoom < .1 ? +(camera.zoom * 100).toFixed(2) : Math.round(camera.zoom * 100)}%</button>
            {popup === 'zoom' && <div className="ic-menu ic-menu-up ic-menu-right">{menuButtons([
              action('Fit All', () => { fit(); setPopup(null) }), action('Fit Selection', () => { fit(true); setPopup(null) }),
              action('Reset to 100%', () => { zoom(1); setPopup(null) }),
            ])}</div>}
          </div>
          <button className="ic-icon" aria-label="Zoom in" onClick={() => zoom(camera.zoom * 1.25)}><Plus /></button>
          <button className="ic-icon" aria-label="Fit All" title="Fit All" onClick={() => fit()}><Maximize /></button>
        </div>
        {panelOpen && <CanvasInspector project={project} stageWidth={size.width} selected={chosen} activeEdge={activeEdge} mediaTools={mediaInspector}
          select={id => {
            const object = indexed.map.get(id)
            if (object && object.parentId && indexed.map.get(object.parentId)?.stack) revealCard(object)
            else pick(id)
          }} update={changeObject} updateEdge={(edge, patch) => edit(project.objects, project.edges.map(item => item.id === edge.id ? { ...item, ...patch } : item))}
          reorder={reorder} moveIntoFrame={moveIntoFrame} fitFrame={fitFrame} settings={updateSettings} flipCard={flipCard}
          editBack={object => { if (validForEdit(object)) setEditingBack(object.id) }} attachBack={object => void addFiles(object.id, 'back')}
          removeBackAttachment={object => changeObject(object, { back: { ...cardFace(object, 'back'), assetId: undefined, imageEdits: undefined, audioAppearance: undefined } })}
          editSmartlink={(object, side) => { if (validForEdit(object)) openSmartlinkEditor(object, side) }}
          updateSmartlink={updateSmartlink} removeSmartlink={removeSmartlink}
          selectStackMember={(_, member) => revealCard(member)} removeFromStack={removeFromStack} setStackFanned={changeStackLayout}
          unstack={object => stackAction(() => unstackAll(project.objects, object.id), object.stack?.order[0])}
          deleteStack={object => { setStackToDelete(object.id); show('deleteStack') }} />}
        {(feedback || error) && <div className="ic-toast" role="status" onPointerDown={event => event.stopPropagation()}>{feedback || error}
          {error && canEdit && <><button onClick={() => void flush().catch(onError)}>Retry</button><button onClick={() => show('export')}>Export current draft</button></>}<button className="ic-icon" aria-label="Dismiss message" onClick={() => setFeedback('')}><X /></button></div>}
      </>}
      {play && <div className="ic-player" onPointerDown={event => event.stopPropagation()}>
        <button className="ic-button" onClick={() => changeStop(-1)}>Previous</button>
        <span>{play.index + 1} / {project.stops.length} · {project.stops[play.index]?.name}</span>
        <button className="ic-button" onClick={() => changeStop(1)}>Next</button>
        <button className="ic-button" onClick={() => setPlay({ ...play, automatic: !play.automatic })}>{play.automatic ? 'Pause' : 'Auto play'}</button>
        <button className="ic-icon" aria-label="Exit presentation" onClick={() => setPlay(undefined)}><X /></button>
      </div>}
    </div>
    {canEdit && files && <ImportDialog files={files} relink={!!replaceId && (replaceSide === 'front' || !!indexed.map.get(replaceId)?.back?.assetId)}
      close={() => { setFiles(undefined); setReplaceId(''); setReplaceSide('front') }} onImport={importAssets} />}
    {modal === 'details' && <ProjectDetails project={project} close={() => setModal(null)} onSave={async (next, assets) => {
      await write([next], assets); setModal(null)
    }} />}
    {modal === 'subcanvas' && <ProjectDetails project={createProject('', project.id)} close={() => setModal(null)} onSave={async (child, assets) => {
      const position = screenToWorld({ x: size.width * .49, y: size.height * .44 }, camera)
      const tile = makeObject('canvas', position, { name: child.name, targetId: child.id })
      await write([{ ...project, objects: [...project.objects, tile], updatedAt: Date.now() }, child], assets)
      setSelected([tile.id]); setModal(null)
    }} />}
    {modal === 'move' && <CanvasDialog title="Move canvas project" close={() => setModal(null)}>
      <div className="ic-form"><label>Move to<select value={moveTarget} onChange={event => setMoveTarget(event.target.value)}>
        <option value="">Top-level projects</option>
        {projects.filter(item => !ancestors(projects, item.id).some(ancestor => ancestor.trashedAt) &&
          item.id !== project.id && !descendants(projects, project.id).some(child => child.id === item.id))
          .map(item => <option key={item.id} value={item.id}>{ancestors(projects, item.id).map(ancestor => ancestor.name).join(' / ')}</option>)}
      </select></label>
      {feedback && <p role="alert">{feedback}</p>}
      <div className="ic-dialog-actions"><button className="ic-button ic-primary" onClick={() => void moveProject()}>Move</button></div></div>
    </CanvasDialog>}
    {modal === 'trash' && <CanvasDialog title="Move project to Trash" close={() => setModal(null)}>
      <div className="ic-form"><p>{project.name} {children.length ? 'and all its SubCanvases will move to Trash together.' : 'will move to Trash.'}</p>
        <p>You can restore it from Trash.</p>
        {feedback && <p role="alert">{feedback}</p>}
        <div className="ic-dialog-actions"><button className="ic-button" onClick={() => setModal(null)}>Cancel</button>
          <button className="ic-button ic-primary" onClick={() => {
            void write([{ ...project, trashedAt: Date.now(), updatedAt: Date.now() }]).then(goHome).catch(onError)
          }}>Move to Trash</button></div>
      </div>
    </CanvasDialog>}
    {modal === 'deleteStack' && pendingDelete?.stack && <CanvasDialog title="Delete card stack" close={() => setModal(null)}>
      <div className="ic-form"><p>{pendingDelete.name} contains {pendingDelete.stack.order.length} {pendingDelete.stack.order.length === 1 ? 'card' : 'cards'}.</p>
        <div className="ic-dialog-actions"><button className="ic-button" onClick={() => setModal(null)}>Cancel</button>
          <button className="ic-button" onClick={() => { stackAction(() => unstackAll(project.objects, pendingDelete.id), pendingDelete.stack?.order[0]); setModal(null) }}>Unstack and keep cards</button>
          <button className="ic-button" onClick={() => {
            const ids = expandSelection([pendingDelete.id])
            if (!canTransform(ids)) { setModal(null); return }
            edit(project.objects.filter(item => !ids.has(item.id)), project.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to)))
            setSelected([]); setModal(null)
          }}>Delete stack and its cards</button>
        </div>
      </div>
    </CanvasDialog>}
    {saveModes.some(mode => mode === modal) && <CanvasSaveDialogs mode={modal as typeof saveModes[number]} project={project} projects={projects}
      close={() => setModal(null)} flush={() => flush()} write={write} refresh={async () => { await refresh(); resetHistory(); setSelected([]) }}
      onOpen={id => { setModal(null); openCanvas(id) }} />}
    {modal === 'find' && <CanvasDialog title="Find in canvas" close={() => setModal(null)}>
      <div className="ic-form"><label>Search<input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="ic-row"><label>Scope<select value={findScope} onChange={event => setFindScope(event.target.value)}>
          <option value="canvas">This Canvas</option><option value="children">Include SubCanvases</option><option value="all">All Croft</option></select></label>
          <label>Object type<select value={findKind} onChange={event => setFindKind(event.target.value)}><option value="">All types</option>
            {Object.entries(kinds).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label></div>
        <div className="ic-result-list">{matches.map(({ canvas, object, side, title, location, description }) => <button key={canvas.id + object.id + (side ?? '')} onClick={() => {
          setModal(null); if (canvas.id === project.id) jumpTo(object.id, side); else openCanvas(canvas.id, object.id, side)
        }}><strong>{title}</strong><small>{location} · {kinds[object.kind]}</small><span>{description}</span></button>)}
          {query && !matches.length && <p>No matching canvas objects.</p>}</div>
      </div>
    </CanvasDialog>}
    {modal === 'smartlink' && <CanvasDialog title={smartlinkBatch ? `Add ${smartlinkBatch.length} Smartlinks` : smartlinkTarget?.id ? 'Edit Smartlink' : 'Add Smartlink'} close={() => setModal(null)}>
      <form className="ic-form" onSubmit={event => { event.preventDefault(); applySmartlinkEditor() }}>
        {smartlinkBatch ? <>
          <p>Review these links. Croft creates one object per link in one undo step. External content stays unloaded until you allow a provider.</p>
          <ul className="ic-smartlink-batch">{smartlinkBatch.map((link, index) => <li key={`${link.canonicalUrl}-${index}`}><strong>{providerLabel(link.provider)}</strong><span>{link.canonicalUrl}</span></li>)}</ul>
        </> : <>
          <label>URL<input type="url" value={smartlinkForm.url} autoFocus required maxLength={2048}
            placeholder="https://youtu.be/… or https://x.com/…" onChange={event => {
              const url = event.currentTarget.value
              setSmartlinkForm(current => ({ ...current, url }))
            }} /></label>
          <label>Title (optional)<input type="text" maxLength={512} value={smartlinkForm.title}
            onChange={event => {
              const title = event.currentTarget.value
              setSmartlinkForm(current => ({ ...current, title }))
            }} /></label>
          <label>Notes (optional)<textarea rows={3} maxLength={16_384} value={smartlinkForm.notes}
            onChange={event => {
              const notes = event.currentTarget.value
              setSmartlinkForm(current => ({ ...current, notes }))
            }} /></label>
          <p className="ic-colour-hint">Only YouTube videos and public X posts can use live embeds. Other web addresses stay local bookmarks. Providers are not contacted until you allow them.</p>
        </>}
        {smartlinkError && <p role="alert">{smartlinkError}</p>}
        <div className="ic-dialog-actions"><button type="button" className="ic-button" onClick={() => setModal(null)}>Cancel</button>
          <button type="submit" className="ic-button ic-primary">{smartlinkBatch ? `Add ${smartlinkBatch.length} Smartlinks` : smartlinkTarget?.id ? 'Save Smartlink' : 'Add Smartlink'}</button></div>
      </form>
    </CanvasDialog>}
    {modal === 'embed' && <CanvasDialog title="Embed Croft page" close={() => setModal(null)}><div className="ic-form ic-result-list">
      {[['handbook', 'Studio handbook'], ['weekly', 'Weekly studio notes'], ['meeting', 'Meeting notes'], ['projects', 'Projects']].map(([id, name]) =>
        <button key={id} onClick={() => { add('page', undefined, { targetId: id, name }); setModal(null) }}><FileText />{name}</button>)}
    </div></CanvasDialog>}
    {modal === 'link' && <CanvasDialog title="Link existing canvas" close={() => setModal(null)}><div className="ic-form ic-result-list">
      <p>Adding or deleting a link leaves the referenced project in place.</p>
      {projects.filter(item => item.id !== project.id && !ancestors(projects, item.id).some(ancestor => ancestor.trashedAt)).map(item =>
        <button key={item.id} onClick={() => { add('canvas', undefined, { targetId: item.id, name: item.name, referenceOnly: true }); setModal(null) }}>
          <Layers />{ancestors(projects, item.id).map(ancestor => ancestor.name).join(' / ')}
        </button>)}
    </div></CanvasDialog>}
    {modal === 'preview' && preview && <CanvasDialog title={projects.find(item => item.id === preview.targetId)?.name ?? preview.name} close={() => setModal(null)}>
      <div className="ic-form">
        {preview.kind === 'canvas' && projects.find(item => item.id === preview.targetId) &&
          <CanvasThumbnail project={projects.find(item => item.id === preview.targetId)!} />}
        <p>Read-only preview</p>
        <div className="ic-dialog-actions"><button className="ic-button ic-primary" onClick={() => { setModal(null); openObject(preview) }}>Open Full Page</button></div>
      </div>
    </CanvasDialog>}
    {modal === 'export' && <CanvasExportDialog close={() => setModal(null)} projects={projects} project={project}
      selectedIds={selected} dark={dark} openBackup={() => show('backup')} />}
    {modal === 'backup' && <CanvasBackupDialog close={() => setModal(null)} flush={flush} canRestore={canEdit} />}
    {modal === 'presentation' && <CanvasDialog title="Presentation" close={() => setModal(null)}>
      <div className="ic-form"><label>Stop name<input value={stopName} placeholder="Current view" onChange={event => setStopName(event.target.value)} /></label>
        <div className="ic-row"><label>Seconds<input type="number" min={1} max={120} value={duration}
          onChange={event => setDuration(Math.max(1, Math.min(120, Number(event.target.value) || 1)))} /></label>
          <button className="ic-button" onClick={() => {
            update({ ...project, stops: [...project.stops, { id: crypto.randomUUID(), name: stopName.trim() || 'Stop ' + (project.stops.length + 1),
              canvasId: project.id, camera, duration }] })
            setStopName('')
          }}><Plus /> Add current view</button>
          {!!children.length && <select aria-label="Add SubCanvas stop" value="" onChange={event => {
            const child = children.find(item => item.id === event.target.value)
            if (child) update({ ...project, stops: [...project.stops, { id: crypto.randomUUID(), name: child.name, canvasId: child.id,
              camera: fitViewport(child.objects.filter(item => !item.hidden && item.kind !== 'group'), size, { padding: 70 }), duration }] })
          }}><option value="">Add SubCanvas stop</option>{children.map(child => <option key={child.id} value={child.id}>{child.name}</option>)}</select>}
        </div>
        <ol className="ic-result-list">{project.stops.map((stop, index) => <li className="ic-row" key={stop.id}>
          <strong>{index + 1}. {stop.name}</strong><small>{stop.duration}s</small>
          <button className="ic-icon" aria-label={'Move ' + stop.name + ' earlier'} disabled={index === 0} onClick={() => {
            const stops = [...project.stops]
            stops.splice(index - 1, 0, stops.splice(index, 1)[0])
            update({ ...project, stops })
          }}>↑</button>
          <button className="ic-icon" aria-label={'Remove stop ' + stop.name} onClick={() => update({ ...project, stops: project.stops.filter(item => item.id !== stop.id) })}><Trash2 /></button>
        </li>)}</ol>
        <form className="ic-row" onSubmit={event => {
          event.preventDefault()
          const values = new FormData(event.currentTarget)
          setModal(null)
          startPresentation(values.has('automatic'), values.has('loop'), values.has('smooth'))
        }}>
          <label className="ic-inline"><input type="checkbox" name="automatic" /> Automatic</label>
          <label className="ic-inline"><input type="checkbox" name="loop" /> Loop</label>
          <label className="ic-inline"><input type="checkbox" name="smooth" defaultChecked /> Smooth</label>
          <button className="ic-button ic-primary" disabled={!project.stops.length}><Play /> Present</button>
        </form>
      </div>
    </CanvasDialog>}
    {editing && <CanvasDialog title={'Edit ' + kinds[editing.kind].toLowerCase()} close={() => setEditing(undefined)}>
      <form className="ic-form" onSubmit={event => {
        event.preventDefault()
        const values = new FormData(event.currentTarget)
        changeObject(editing, { text: String(values.get('text') ?? '') }); setEditing(undefined)
      }}>
        <label>Text<textarea autoFocus rows={5} name="text" maxLength={20_000} defaultValue={editing.text} /></label>
        <div className="ic-dialog-actions"><button type="button" className="ic-button" onClick={() => setEditing(undefined)}>Cancel</button>
          <button className="ic-button ic-primary">Apply</button></div>
      </form>
    </CanvasDialog>}
    {backBeingEdited && <CardBackEditor object={backBeingEdited} close={() => setEditingBack(undefined)} save={patch => {
      changeObject(backBeingEdited, { back: { ...cardFace(backBeingEdited, 'back'), ...patch } })
      setEditingBack(undefined)
    }} />}
  </section>
}

function Minimap({ objects, camera, size, onCamera }: {
  objects: CanvasObject[]; camera: Camera; size: { width: number; height: number }; onCamera: (camera: Camera) => void
}) {
  const top = screenToWorld({ x: 0, y: 0 }, camera)
  const bottom = screenToWorld({ x: size.width, y: size.height }, camera)
  const centre = { x: (top.x + bottom.x) / 2, y: (top.y + bottom.y) / 2 }
  const reach = Math.max(bottom.x - top.x, bottom.y - top.y, 240) * 4
  const local = objects.filter(item => Math.abs(item.x - centre.x) < reach && Math.abs(item.y - centre.y) < reach)
  const left = Math.min(top.x, ...local.map(item => item.x)) - 20
  const right = Math.max(bottom.x, ...local.map(item => item.x + item.width)) + 20
  const upper = Math.min(top.y, ...local.map(item => item.y)) - 20
  const lower = Math.max(bottom.y, ...local.map(item => item.y + item.height)) + 20
  const width = Math.max(right - left, 1)
  const height = Math.max(lower - upper, 1)
  function centreAt(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = left + (event.clientX - bounds.left) * width / bounds.width
    const y = upper + (event.clientY - bounds.top) * height / bounds.height
    onCamera({ ...camera, x: size.width / 2 - x * camera.zoom, y: size.height / 2 - y * camera.zoom })
  }
  return <div className="ic-minimap" onPointerDown={event => event.stopPropagation()}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Canvas minimap"
      role="button" tabIndex={0} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); centreAt(event) }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) centreAt(event) }}
      onKeyDown={event => {
        if (event.key === 'Enter') onCamera(fitViewport(objects, size, { padding: 75 }))
      }}>
      {local.slice(0, 700).map(item => <rect key={item.id} x={item.x - left} y={item.y - upper} width={item.width}
        height={item.collapsed ? 36 : item.height} rx={3} fill={item.kind === 'text' ? 'var(--muted)' : item.colour} fillOpacity={.7} />)}
      <rect className="ic-minimap-view" x={top.x - left} y={top.y - upper} width={Math.max(1, bottom.x - top.x)} height={Math.max(1, bottom.y - top.y)} />
    </svg>
  </div>
}
