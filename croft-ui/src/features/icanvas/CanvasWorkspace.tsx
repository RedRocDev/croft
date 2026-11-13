import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import RBush from 'rbush'
import {
  ArrowDownToLine, ArrowRight, Box, ChevronDown, ChevronRight, Circle, Copy, Eye, FileText, Hand, Image,
  Layers, Lock, Maximize, Minus, MoreHorizontal, MousePointer2, PanelLeft, PenLine, Play, Plus, Redo2, RotateCw,
  Save, Search, Square, StickyNote, Trash2, Type, Undo2, Unlink, Unlock, X,
} from 'lucide-react'
import { ancestors, createProject, descendants, edgeLabels, kinds, makeObject, objectFlags, palette,
  type Camera, type CanvasAsset, type CanvasEdge, type CanvasObject, type CanvasProject, type CanvasSettings, type EdgeKind, type ObjectKind, type Placement, type Point } from './model'
import {
  connectionEndpoints, fitViewport, GRID_SPACING, intersects, placePoint, rectCenter, rotatedBounds, screenToWorld, snapPoint, worldToScreen, zoomAt,
  type Rect,
} from './geometry'
import { CanvasInspector } from './CanvasInspector'
import { CanvasThumbnail, ObjectContent } from './CanvasVisuals'
import { CanvasDialog, ProjectDetails } from './ProjectViews'
import { CanvasSaveDialogs } from './CanvasSaveDialogs'
import { droppedCanvasFiles, ImportDialog, pickCanvasFiles, type CanvasFile, type CanvasPreparedAsset } from './ImportDialog'
import { exportProject, type CanvasExportFormat } from './portability'
import { getAssets } from './storage'
import { useCanvasEditing } from './useCanvasEditing'
import type { useCanvasProjects } from './useCanvasProjects'
import './canvas.css'

type Tool = 'select' | 'hand' | 'text' | 'note' | 'rectangle' | 'ellipse' | 'stroke' | 'frame' | EdgeKind
type Popup = 'save' | 'view' | 'tools' | 'add' | 'edges' | 'shapes' | 'project' | 'zoom' | null
type Modal = 'details' | 'subcanvas' | 'move' | 'trash' | 'find' | 'versions' | 'checkpoint' | 'recovery' | 'copy' | 'export' | 'presentation' | 'embed' | 'link' | 'preview' | null
type Indexed = { minX: number; minY: number; maxX: number; maxY: number; object: CanvasObject; index: number }
type Gesture = { start: Point; camera: Camera; pointerId: number } & (
  { kind: 'pan' | 'marquee' } | { kind: 'move'; objects: CanvasObject[] } |
  { kind: 'resize' | 'rotate'; object: CanvasObject } | { kind: 'stroke'; points: Point[] })
const colourForEdge = { direction: '#537e67', connection: '#858783', relationship: '#8266a3' }
const isEditor = (target: EventTarget | null) => target instanceof HTMLElement &&
  !!target.closest('input, textarea, select, [contenteditable], [role="dialog"], dialog')
const shapeForAsset = (asset: CanvasAsset): ObjectKind =>
  asset.mime.startsWith('image/') ? 'image' : asset.mime.startsWith('audio/') ? 'audio' : asset.mime.startsWith('video/') ? 'video' : 'file'
const action = (label: string, run: () => void, icon?: React.ReactNode) => ({ label, run, icon })

export function CanvasWorkspace({ project, store, sidebarOpen, sidebarToggleRef, toggleSidebar, openCanvas, goHome, openPage, jump, dark }: {
  project: CanvasProject; store: ReturnType<typeof useCanvasProjects>; sidebarOpen: boolean
  sidebarToggleRef: RefObject<HTMLButtonElement | null>; toggleSidebar: () => void
  openCanvas: (id: string, objectId?: string) => void; goHome: () => void; openPage: (id: string) => void
  jump?: { id: string; event: number }; dark: boolean
}) {
  const { projects, update, write, flush, refresh, status, error } = store
  const { edit, step, canUndo, canRedo, resetHistory } = useCanvasEditing(project, update)
  const stage = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const pointer = useRef<Point>({ x: 0, y: 0 })
  const gesture = useRef<Gesture | null>(null)
  const space = useRef(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [tool, setTool] = useState<Tool>('select')
  const [selected, setSelected] = useState<string[]>([])
  const [edgeId, setEdgeId] = useState('')
  const [fromId, setFromId] = useState('')
  const [popup, setPopup] = useState<Popup>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [dragged, setDragged] = useState<CanvasObject[]>([])
  const [marquee, setMarquee] = useState<Rect>()
  const [guides, setGuides] = useState<Point>()
  const [drawing, setDrawing] = useState<Point[]>([])
  const [cameraDraft, setCameraDraft] = useState<Camera>()
  const [toolbarDraft, setToolbarDraft] = useState<Point>()
  const [editing, setEditing] = useState<CanvasObject>()
  const [files, setFiles] = useState<CanvasFile[]>()
  const [replaceId, setReplaceId] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [placement, setPlacement] = useState<Placement>(() => {
    try { return localStorage.getItem('croft-icanvas-placement') === 'free' ? 'free' : 'smart' } catch { return 'smart' }
  })
  const [format, setFormat] = useState<CanvasExportFormat>('croft')
  const [scope, setScope] = useState<'canvas' | 'selection' | 'project'>('project')
  const [exportBackground, setExportBackground] = useState<'clean' | 'grid' | 'transparent'>('clean')
  const [exporting, setExporting] = useState(false)
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
  const camera = play ? project.stops[play.index]?.camera ?? project.camera : cameraDraft ?? project.camera

  const indexed = useMemo(() => {
    const map = new Map(stageProject.objects.map(object => [object.id, object]))
    const flags = new Map(stageProject.objects.map(object => [object.id, objectFlags(object, map)]))
    const visible = stageProject.objects.filter(object => !flags.get(object.id)?.hidden && object.kind !== 'group')
    const tree = new RBush<Indexed>()
    tree.load(visible.map((object, index) => {
      const box = rotatedBounds(object.collapsed ? { ...object, height: 36 } : object, object.rotation)
      return { minX: box.left, minY: box.top, maxX: box.right, maxY: box.bottom, object, index }
    }))
    return { map, flags, visible, tree }
  }, [stageProject.objects])
  const dragMap = new Map(dragged.map(object => [object.id, object]))
  const topLeft = screenToWorld({ x: -100, y: -100 }, camera)
  const bottomRight = screenToWorld({ x: size.width + 100, y: size.height + 100 }, camera)
  const rendered = indexed.tree.search({ minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y })
    .sort((a, b) => a.index - b.index).map(item => dragMap.get(item.object.id) ?? item.object)
  const displayed = new Set(rendered.map(object => object.id))
  for (const object of dragged) if (!displayed.has(object.id) && object.kind !== 'group' && !indexed.flags.get(object.id)?.hidden) rendered.push(object)
  const renderedIds = new Set(rendered.map(object => object.id))
  const chosen = project.objects.filter(object => selected.includes(object.id) && !indexed.flags.get(object.id)?.hidden)
  const activeEdge = project.edges.find(edge => edge.id === edgeId)
  const panelOpen = !play && project.settings.panel !== 'closed' && (chosen.length > 0 || !!activeEdge || project.settings.panel === 'layers')
  const selectedBounds = chosen.map(object => dragMap.get(object.id) ?? object).map(object => rotatedBounds(object, object.rotation))
  const quick = selectedBounds.length ? worldToScreen({
    x: Math.min(...selectedBounds.map(box => box.left)), y: Math.min(...selectedBounds.map(box => box.top)),
  }, camera) : undefined
  const updateSettings = (patch: Partial<CanvasSettings>) => update({ ...project, settings: { ...project.settings, ...patch } }, false)
  const setCamera = (next: Camera) => update({ ...project, camera: next }, false)
  const toggle = (next: Popup) => setPopup(current => current === next ? null : next)
  const show = (next: Modal) => { setPopup(null); setModal(next) }
  const onError = (reason: unknown) => setFeedback(reason instanceof Error ? reason.message : String(reason))
  const validForEdit = (object: CanvasObject) => !indexed.flags.get(object.id)?.hidden && !indexed.flags.get(object.id)?.locked

  useEffect(() => {
    const element = stage.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function jumpTo(id: string) {
    const item = project.objects.find(object => object.id === id)
    if (!item || !size.width) return
    if (indexed.flags.get(id)?.hidden) {
      setFeedback('This item is hidden. Reveal it in Layers to select it.')
      updateSettings({ panel: 'layers' })
      return
    }
    setSelected([id])
    setEdgeId('')
    setCamera(fitViewport([item], size, { max: 1.6 }))
  }

  const completedJump = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (jump && size.width && completedJump.current !== jump.event) {
      completedJump.current = jump.event
      jumpTo(jump.id)
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

  function pick(id: string, multiple = false) {
    const maybe = project.objects.find(object => object.id === id)
    if (maybe && !indexed.flags.get(id)?.hidden) {
      setEdgeId('')
      setSelected(current => multiple ? current.includes(id) ? current.filter(entry => entry !== id) : [...current, id] : [id])
    }
  }

  function chooseTool(next: Tool) {
    setFromId('')
    setTool(next)
    setPopup(null)
    setContextPoint(undefined)
  }

  function changeObject(object: CanvasObject, patch: Partial<CanvasObject>) {
    if (!validForEdit(object) && patch.locked === undefined && patch.hidden === undefined) return
    const next = { ...object, ...patch }
    if (object.kind === 'stroke' && object.points && (next.width !== object.width || next.height !== object.height)) {
      next.points = object.points.map(point => ({ x: point.x * next.width / object.width, y: point.y * next.height / object.height }))
    }
    const members = object.kind === 'group' || object.kind === 'frame' ? expandSelection([object.id]) : new Set([object.id])
    const moving = next.x !== object.x || next.y !== object.y
    const transforming = object.kind === 'group' && (next.rotation !== object.rotation || next.width !== object.width || next.height !== object.height)
    const pivot = rectCenter(object)
    const nextPivot = rectCenter(next)
    const angle = (next.rotation - object.rotation) * Math.PI / 180
    const sx = next.width / object.width
    const sy = next.height / object.height
    edit(project.objects.map(item => {
      if (item.id === object.id) return next
      if (!members.has(item.id) || indexed.flags.get(item.id)?.locked) return item
      if (!transforming) return moving ? { ...item, x: item.x + next.x - object.x, y: item.y + next.y - object.y } : item
      const centre = rectCenter(item)
      const x = (centre.x - pivot.x) * sx
      const y = (centre.y - pivot.y) * sy
      const width = item.width * sx
      const height = item.height * sy
      return { ...item, x: nextPivot.x + x * Math.cos(angle) - y * Math.sin(angle) - width / 2,
        y: nextPivot.y + x * Math.sin(angle) + y * Math.cos(angle) - height / 2,
        width, height, rotation: item.rotation + next.rotation - object.rotation,
        points: item.points?.map(point => ({ x: point.x * sx, y: point.y * sy })) }
    }))
  }

  function reorder(id: string, direction: 'front' | 'back' | 'forward' | 'backward') {
    const objects = [...project.objects]
    const index = objects.findIndex(object => object.id === id)
    if (index < 0 || !validForEdit(objects[index])) return
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
    edit(project.objects.filter(item => !ids.has(item.id)).map(item => item.parentId && ids.has(item.parentId) ? { ...item, parentId: undefined } : item),
      project.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to)))
    setSelected([])
  }

  function duplicate() {
    const copies = chosen.filter(validForEdit).filter(item => item.kind !== 'canvas' && item.kind !== 'frame' && item.kind !== 'group').map(item => ({
      ...item, id: crypto.randomUUID(), x: item.x + 24, y: item.y + 24,
    }))
    if (!copies.length) return
    edit([...project.objects, ...copies])
    setSelected(copies.map(item => item.id))
  }

  function groupSelection() {
    const items = chosen.filter(validForEdit)
    if (items.length < 2 || items.some(item => item.parentId !== items[0].parentId)) return
    const left = Math.min(...items.map(item => item.x))
    const top = Math.min(...items.map(item => item.y))
    const group = makeObject('group', { x: left, y: top }, { parentId: items[0].parentId,
      width: Math.max(...items.map(item => item.x + item.width)) - left, height: Math.max(...items.map(item => item.y + item.height)) - top })
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
    edit(project.objects.map(item => {
      if (item.id === object.id) return { ...item, parentId: frame?.id }
      if (item.id !== frame?.id) return item
      const bounds = rotatedBounds(object, object.rotation)
      const x = Math.min(frame.x, bounds.left - 24)
      const y = Math.min(frame.y, bounds.top - 32)
      return { ...frame, x, y, width: Math.max(frame.x + frame.width, bounds.right + 24) - x,
        height: Math.max(frame.y + frame.height, bounds.bottom + 24) - y }
    }))
  }

  function add(kind: ObjectKind, point = screenToWorld({ x: size.width * .5, y: size.height * .45 }, camera), patch?: Partial<CanvasObject>) {
    const position = project.settings.snapGrid && placement === 'smart' ? placePoint(point, placement) : point
    const containing = [...indexed.visible].reverse().find(object => object.kind === 'frame' && !object.collapsed &&
      !indexed.flags.get(object.id)?.locked && intersects(object, { ...position, width: 0, height: 0 }))
    const object = makeObject(kind, position, { parentId: containing?.id, ...patch })
    const records = containing ? project.objects.map(item => item.id === containing.id ? {
      ...item, width: Math.max(item.width, object.x + object.width - item.x + 24), height: Math.max(item.height, object.y + object.height - item.y + 24),
    } : item) : project.objects
    edit([...records, object])
    setSelected([object.id])
    setEdgeId('')
    if (kind === 'text' || kind === 'note') setEditing(object)
    return object
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

  function start(event: ReactPointerEvent<HTMLElement>, object?: CanvasObject, handle?: 'resize' | 'rotate') {
    if (play || (event.button !== 0 && event.button !== 1) || isEditor(event.target) ||
      (event.target instanceof Element && event.target.closest('audio, video, a, [data-media-control]'))) return
    const screen = localPoint(event)
    const world = screenToWorld(screen, camera)
    setPopup(null)
    setContextPoint(undefined)
    if (event.button === 1 || tool === 'hand' || space.current) {
      gesture.current = { start: screen, camera, kind: 'pan', pointerId: event.pointerId }
    } else if (object && tool in edgeLabels) {
      event.stopPropagation()
      connect(object.id)
      return
    } else if (tool === 'stroke') {
      gesture.current = { start: screen, camera, kind: 'stroke', points: [world], pointerId: event.pointerId }
      setDrawing([world])
    } else if (tool !== 'select') {
      if (['text', 'note', 'rectangle', 'ellipse', 'frame'].includes(tool)) {
        add(tool as ObjectKind, world)
        setTool('select')
      }
      return
    } else if (object) {
      const group = object.parentId ? indexed.map.get(object.parentId) : undefined
      const target = !handle && !event.shiftKey && group?.kind === 'group' ? group : object
      if (event.shiftKey || !selected.includes(target.id)) pick(target.id, event.shiftKey)
      if (event.shiftKey || !validForEdit(target)) return
      const active = expandSelection(selected.includes(target.id) ? selected : [target.id])
      gesture.current = handle ? { start: screen, camera, kind: handle, object: target, pointerId: event.pointerId } : {
        start: screen, camera, kind: 'move', pointerId: event.pointerId, objects: project.objects.filter(item =>
          active.has(item.id) && !indexed.flags.get(item.id)?.locked),
      }
    } else {
      setSelected([])
      setEdgeId('')
      gesture.current = { start: screen, camera, kind: 'marquee', pointerId: event.pointerId }
    }
    event.preventDefault()
    const target = gesture.current?.kind === 'move' ? event.currentTarget : stage.current
    target?.setPointerCapture(event.pointerId)
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const screen = localPoint(event)
    pointer.current = screen
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
      const centre = worldToScreen(rectCenter(active.object), camera)
      const angle = Math.atan2(screen.y - centre.y, screen.x - centre.x) * 180 / Math.PI + 90
      setDragged([{ ...active.object, rotation: event.shiftKey ? Math.round(angle / 15) * 15 : angle }])
    }
    if (active.kind === 'resize') {
      const source = active.object
      const radians = -source.rotation * Math.PI / 180
      const localX = delta.x * Math.cos(radians) - delta.y * Math.sin(radians)
      const localY = delta.x * Math.sin(radians) + delta.y * Math.cos(radians)
      const width = Math.max(24, source.width + localX)
      const preserve = event.shiftKey || source.kind === 'image' || source.kind === 'video'
      const height = preserve ? Math.max(24, width * source.height / source.width) : Math.max(24, source.height + localY)
      setDragged([{ ...source, width, height }])
    }
    if (active.kind === 'move' && active.objects.length && Math.hypot(dx, dy) > 2) {
      const source = active.objects.find(item => selected.includes(item.id)) ?? active.objects[0]
      let position = { x: source.x + delta.x, y: source.y + delta.y }
      if (project.settings.snapGrid && !event.altKey) position = snapPoint(position)
      if (project.settings.snapObjects && !event.altKey) {
        const tolerance = 7 / camera.zoom
        let closestX = tolerance
        let closestY = tolerance
        let shiftX = 0
        let shiftY = 0
        const moving = new Set(active.objects.map(object => object.id))
        for (const target of indexed.visible) {
          if (moving.has(target.id)) continue
          for (const x of [target.x, target.x + target.width / 2, target.x + target.width]) {
            for (const offset of [0, source.width / 2, source.width]) {
              const difference = x - (position.x + offset)
              if (Math.abs(difference) < closestX) { closestX = Math.abs(difference); shiftX = difference }
            }
          }
          for (const y of [target.y, target.y + target.height / 2, target.y + target.height]) {
            for (const offset of [0, source.height / 2, source.height]) {
              const difference = y - (position.y + offset)
              if (Math.abs(difference) < closestY) { closestY = Math.abs(difference); shiftY = difference }
            }
          }
        }
        position = { x: position.x + shiftX, y: position.y + shiftY }
      }
      setGuides(project.settings.guides ? worldToScreen(position, camera) : undefined)
      setDragged(active.objects.map(item => ({ ...item, x: item.x + position.x - source.x, y: item.y + position.y - source.y })))
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
    if (commit && dragged.length) {
      const next = new Map(dragged.map(object => [object.id, object]))
      if (active?.kind === 'resize' || active?.kind === 'rotate') changeObject(active.object, next.get(active.object.id) ?? {})
      else edit(project.objects.map(object => next.get(object.id) ?? object))
    }
    setDragged([])
    setMarquee(undefined)
    setGuides(undefined)
    setCameraDraft(undefined)
    setDrawing([])
  }

  useEffect(() => {
    const element = stage.current
    if (!element) return
    function wheel(event: WheelEvent) {
      if (play || isEditor(event.target)) return
      event.preventDefault()
      const amount = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      setCamera(zoomAt(project.camera, localPoint(event), project.camera.zoom * Math.exp(-amount * .0018)))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [project, play])

  async function saveNow() { await flush(project.id) }
  function zoom(scale: number) { setCamera(zoomAt(project.camera, { x: size.width / 2, y: size.height / 2 }, scale)) }
  function fit(selection = false) {
    const objects = selection ? chosen : indexed.visible
    if (objects.length && size.width) setCamera(fitViewport(objects.map(object => object.collapsed ? { ...object, height: 36 } : object), size, { padding: 75 }))
  }

  useEffect(() => {
    const onBlur = () => { space.current = false; if (gesture.current) finish(false) }
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditor(event.target) || modal || files || editing || document.querySelector('dialog[open]')) return
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
        if (key === 's') { event.preventDefault(); if (event.shiftKey) show('copy'); else void saveNow().catch(onError) }
        if (key === 'z' || key === 'y') { event.preventDefault(); step(key === 'y' || event.shiftKey ? 'redo' : 'undo') }
        if (key === 'f') { event.preventDefault(); setQuery(''); setFindScope('canvas'); show('find') }
        return
      }
      if (key === ' ') { event.preventDefault(); space.current = true }
      if (key === 'escape') { setPopup(null); setContextPoint(undefined); setSelected([]); setFromId(''); setEdgeId(''); setTool('select') }
      if (key === 'delete' || key === 'backspace') { event.preventDefault(); removeSelection() }
      if (key.startsWith('arrow') && chosen.length) {
        event.preventDefault()
        const delta = event.shiftKey ? 10 : 1
        const ids = expandSelection(chosen.filter(validForEdit).map(item => item.id))
        edit(project.objects.map(item => ids.has(item.id) && !indexed.flags.get(item.id)?.locked ? { ...item,
          x: item.x + (key === 'arrowright' ? delta : key === 'arrowleft' ? -delta : 0), y: item.y + (key === 'arrowdown' ? delta : key === 'arrowup' ? -delta : 0),
        } : item))
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

  async function addFiles(replace = '') {
    setPopup(null)
    setReplaceId(replace)
    try {
      const chosenFiles = await pickCanvasFiles()
      if (chosenFiles === undefined) fileInput.current?.click()
      else if (chosenFiles.length) setFiles(chosenFiles)
    } catch (reason) { onError(reason) }
  }

  async function importAssets(assets: CanvasPreparedAsset[]) {
    if (!assets.length) return
    const begin = screenToWorld(pointer.current.x ? pointer.current : { x: size.width * .47, y: size.height * .43 }, camera)
    const origin = placement === 'smart' ? placePoint(begin, placement) : begin
    const edited = replaceId ? project.objects.map(object => object.id === replaceId ? { ...object, assetId: assets[0].id, name: assets[0].name } : object) : project.objects
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
      if (assets.length !== 1 || !replaced || shapeForAsset(assets[0]) !== replaced.kind) throw new Error('Choose one matching media file.')
    }
    await write([{ ...project, objects: [...edited, ...added], updatedAt: Date.now() }], assets)
    setSelected(replaceId ? [replaceId] : added.map(object => object.id))
  }

  function previewObject(object: CanvasObject) { setPreview(object); show('preview') }
  function openObject(object: CanvasObject) {
    if (object.kind === 'canvas' && object.targetId) openCanvas(object.targetId)
    else if (object.kind === 'page' && object.targetId) openPage(object.targetId)
    else if ((object.kind === 'text' || object.kind === 'note') && validForEdit(object)) setEditing(object)
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
  const matches = query.trim() ? findProjects.flatMap(canvas => canvas.objects.filter(object => (!findKind || object.kind === findKind) &&
    (object.name + ' ' + object.text + ' ' + (object.caption ?? '')).toLowerCase().includes(query.trim().toLowerCase()))
    .map(object => ({ canvas, object }))).slice(0, 100) : []
  const activeSettings = stageProject.settings
  const menuButtons = (items: ReturnType<typeof action>[]) => items.map(item => <button key={item.label} onClick={item.run}>{item.icon}{item.label}</button>)
  const tools = [{ id: 'select', name: 'Select', icon: MousePointer2 }, { id: 'hand', name: 'Hand', icon: Hand },
    { id: 'text', name: 'Text', icon: Type }, { id: 'note', name: 'Sticky note', icon: StickyNote }, { id: 'stroke', name: 'Draw', icon: PenLine }] as const
  const currentColour = chosen.length === 1 && chosen[0].mode === 'card' ? chosen[0].colour : undefined
  const showQuick = !!quick && !play && !dragged.length && !marquee && chosen.some(item => renderedIds.has(item.id) || item.kind === 'group')

  return <section className="ic-workspace" data-presentation={!!play}>
    {!play && <header className="ic-header">
      {!sidebarOpen && <button ref={sidebarToggleRef} className="ic-icon" aria-label="Open sidebar" onClick={toggleSidebar}><PanelLeft /></button>}
      <nav className="ic-breadcrumbs" aria-label="Canvas breadcrumbs"><button onClick={goHome}>Home</button>
        {chain.map(item => <span key={item.id}><ChevronRight size={13} /><button title={item.name} aria-current={item.id === project.id ? 'page' : undefined}
          onClick={() => item.id === project.id ? show('details') : openCanvas(item.id)}>{item.icon} <span>{item.name}</span></button></span>)}
      </nav>
      <div className="ic-header-actions">
        <button className="ic-icon" title="Undo" aria-label="Undo" disabled={!canUndo} onClick={() => step('undo')}><Undo2 /></button>
        <button className="ic-icon" title="Redo" aria-label="Redo" disabled={!canRedo} onClick={() => step('redo')}><Redo2 /></button>
        <div className="ic-anchor"><button className="ic-button" aria-label="View" aria-expanded={popup === 'view'} onClick={() => toggle('view')}><Eye /> <span>View</span></button>
          {popup === 'view' && <div className="ic-menu ic-menu-right">
            {(['dots', 'lines', 'none'] as const).map(grid => <button key={grid} aria-pressed={project.settings.grid === grid}
              onClick={() => updateSettings({ grid })}>{grid[0].toUpperCase() + grid.slice(1)}</button>)}
            <hr />
            <label><input type="checkbox" checked={project.settings.minimap} onChange={event => updateSettings({ minimap: event.target.checked })} /> Minimap</label>
            {(Object.keys(edgeLabels) as EdgeKind[]).map(kind => <label key={kind}><input type="checkbox" checked={project.settings.showEdges[kind]}
              onChange={event => updateSettings({ showEdges: { ...project.settings.showEdges, [kind]: event.target.checked } })} /> {edgeLabels[kind]}</label>)}
            <button onClick={() => { updateSettings({ panel: project.settings.panel === 'closed' ? 'layers' : 'closed' }); setPopup(null) }}><Layers /> {project.settings.panel === 'closed' ? 'Show inspector' : 'Hide inspector'}</button>
          </div>}
        </div>
        <button className="ic-icon" aria-label="Presentation" title="Presentation" onClick={() => show('presentation')}><Play /></button>
        <div className="ic-anchor"><span className="sr-only" role="status">{status}</span><button className="ic-button" aria-label="Save menu" aria-expanded={popup === 'save'} onClick={() => toggle('save')}><Save /> <span>{status}</span><ChevronDown size={12} /></button>
          {popup === 'save' && <div className="ic-menu ic-menu-right">{menuButtons([
            action('Save', () => { setPopup(null); void saveNow().catch(onError) }), action('Save VC', () => show('checkpoint')), action('Save As…', () => show('copy')),
          ])}</div>}
        </div>
        <div className="ic-anchor"><button className="ic-icon" title="Project menu" aria-label="Project menu" aria-expanded={popup === 'project'} onClick={() => toggle('project')}><MoreHorizontal /></button>
          {popup === 'project' && <div className="ic-menu ic-menu-right">{menuButtons([
            action('Project Details', () => show('details')), action('Find in canvas', () => show('find'), <Search />),
            action('Move project…', () => { setMoveTarget(project.parentId ?? ''); show('move') }),
            action('Move to Trash…', () => show('trash'), <Trash2 />),
            action('Version History', () => show('versions')), action('Recovery snapshots', () => show('recovery')),
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
    <div className="ic-stage" ref={stage} role="region" aria-label="Canvas" data-tool={tool} data-dragover={dropActive}
      style={{ '--ic-grid-size': Math.max(7, GRID_SPACING * camera.zoom) + 'px', '--ic-grid-x': camera.x + 'px', '--ic-grid-y': camera.y + 'px' } as CSSProperties}
      data-grid={activeSettings.grid} onPointerDown={event => start(event)} onPointerMove={move}
      onPointerUp={() => finish()} onPointerCancel={() => finish(false)}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropActive(true) } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false) }}
      onDrop={event => {
        event.preventDefault()
        setDropActive(false)
        if (play) return
        pointer.current = localPoint(event)
        setReplaceId('')
        void droppedCanvasFiles(event.dataTransfer).then(items => { if (items.length) setFiles(items) }).catch(onError)
      }}>
      <div className={'ic-world' + (play?.smooth ? ' ic-smooth' : '')} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        {rendered.map(object => {
          const target = object.targetId ? projects.find(candidate => candidate.id === object.targetId &&
            !ancestors(projects, candidate.id).some(ancestor => ancestor.trashedAt)) : undefined
          const picked = !play && selected.includes(object.id)
          const locked = indexed.flags.get(object.id)?.locked
          const card = object.mode === 'card'
          return <div key={object.id} className="ic-item" data-kind={object.kind} data-mode={object.mode} data-selected={picked}
            data-collapsed={!!object.collapsed} data-border={!!object.border} data-from={fromId === object.id}
            style={{ left: object.x, top: object.y, width: object.width, height: object.collapsed ? 36 : object.height,
              transform: `rotate(${object.rotation}deg)`, opacity: object.opacity, '--ic-item-colour': object.colour } as CSSProperties}
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
            onContextMenu={event => { if (!play) { event.preventDefault(); pick(object.id); setContextPoint(localPoint(event)) } }}
            data-testid={'canvas-object-' + object.id} aria-label={object.name}>
            {object.kind === 'frame' ? <span className="ic-frame-label"><Box size={14} /> {object.name}{object.collapsed && <small>{project.objects.filter(item => item.parentId === object.id).length} items</small>}</span> : <>
              {card && !['canvas', 'page', 'file', 'note'].includes(object.kind) && <span className="ic-object-title">{object.name}</span>}
              <ObjectContent object={object} target={target} reloadMedia={object.assetId} replace={() => void addFiles(object.id)} />
              {card && object.caption && <small className="ic-caption">{object.caption}</small>}
            </>}
            {picked && !locked && <>
              <button className="ic-handle ic-resize" tabIndex={-1} aria-label={'Resize ' + object.name}
                onPointerDown={event => { event.stopPropagation(); start(event, object, 'resize') }} />
              <button className="ic-handle ic-rotate" tabIndex={-1} aria-label={'Rotate ' + object.name}
                onPointerDown={event => { event.stopPropagation(); start(event, object, 'rotate') }} />
            </>}
          </div>
        })}
        <svg className="ic-edge-layer" width="1" height="1" aria-label="Canvas connections">
          <defs><marker id="ic-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={colourForEdge.direction} /></marker></defs>
          {stageProject.edges.map(edge => {
            const from = dragMap.get(edge.from) ?? indexed.map.get(edge.from)
            const to = dragMap.get(edge.to) ?? indexed.map.get(edge.to)
            if (!activeSettings.showEdges[edge.kind] || !from || !to || indexed.flags.get(from.id)?.hidden || indexed.flags.get(to.id)?.hidden ||
              !intersects({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.max(from.x + from.width, to.x + to.width) - Math.min(from.x, to.x),
                height: Math.max(from.y + from.height, to.y + to.height) - Math.min(from.y, to.y) },
              { ...topLeft, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y })) return null
            const ends = connectionEndpoints(from, to)
            return <g key={edge.id} data-edge-kind={edge.kind} onPointerDown={event => {
              if (!play) { event.stopPropagation(); setEdgeId(edge.id); setSelected([]) }
            }}>
              <line className="ic-edge-hit" x1={ends.from.x} y1={ends.from.y} x2={ends.to.x} y2={ends.to.y} stroke="transparent" strokeWidth={14 / camera.zoom} />
              <line x1={ends.from.x} y1={ends.from.y} x2={ends.to.x} y2={ends.to.y} stroke={colourForEdge[edge.kind]}
                strokeWidth={edge.id === edgeId ? 3 : 2} strokeDasharray={edge.kind === 'relationship' ? '5 5' : undefined} markerEnd={edge.kind === 'direction' ? 'url(#ic-arrow)' : undefined} />
              {edge.label && <text x={(ends.from.x + ends.to.x) / 2} y={(ends.from.y + ends.to.y) / 2 - 7} textAnchor="middle">{edge.label}</text>}
            </g>
          })}
          {drawing.length > 1 && <polyline points={drawing.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={palette[6]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </div>
      {marquee && <div className="ic-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.width, height: marquee.height }} />}
      {guides && <><div className="ic-guide ic-guide-x" style={{ left: guides.x }} /><div className="ic-guide ic-guide-y" style={{ top: guides.y }} /></>}
      {!play && <>
        {!project.objects.length && !dropActive && <div className="ic-empty"><Layers size={26} /><h2>Start with an idea</h2><p>Drop files here or choose a tool to add something.</p>
          <button className="ic-button" onPointerDown={event => event.stopPropagation()} onClick={() => void addFiles()}><Plus /> Add files</button></div>}
        {dropActive && <div className="ic-drop-target">Drop files to add them to this canvas</div>}
        <div className="ic-toolbar" ref={toolbar} data-mode={project.settings.toolbar}
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
        </div>
        {showQuick && quick && <div className="ic-quick" role="toolbar" aria-label="Selection actions" onPointerDown={event => event.stopPropagation()}
          style={{ left: Math.max(8, Math.min(size.width - 225, quick.x)), top: Math.max(58, quick.y - 42) }}>
          {chosen.length === 1 && <>
            {['canvas', 'page'].includes(chosen[0].kind) && <button className="ic-icon" aria-label="Quick Preview" title="Quick Preview" onClick={() => previewObject(chosen[0])}><Eye /></button>}
            {chosen[0].kind === 'group' ? <button className="ic-icon" aria-label="Ungroup" title="Ungroup" onClick={() => ungroup(chosen[0])}><Unlink /></button> :
              <button className="ic-icon" aria-label={currentColour ? 'Remove Card' : 'Convert to Card'} title={currentColour ? 'Remove Card' : 'Convert to Card'}
                onClick={() => changeObject(chosen[0], { mode: currentColour ? 'direct' : 'card' })}><Box /></button>}
            <button className="ic-icon" aria-label="Rotate 15 degrees" title="Rotate 15 degrees"
              onClick={() => changeObject(chosen[0], { rotation: (chosen[0].rotation + 15) % 360 })}><RotateCw /></button>
            <button className="ic-icon" aria-label={chosen[0].locked ? 'Unlock' : 'Lock'} title={chosen[0].locked ? 'Unlock' : 'Lock'}
              onClick={() => changeObject(chosen[0], { locked: !chosen[0].locked })}>{chosen[0].locked ? <Unlock /> : <Lock />}</button>
          </>}
          {chosen.length > 1 && <button className="ic-icon" aria-label="Group selection" title="Group selection" onClick={groupSelection}><Layers /></button>}
          <button className="ic-icon" aria-label="Duplicate" title="Duplicate" onClick={duplicate}><Copy /></button>
          <button className="ic-icon" aria-label="Delete selected" title="Delete selected" onClick={removeSelection}><Trash2 /></button>
        </div>}
        {contextPoint && chosen.length === 1 && <div className="ic-menu ic-context-menu" onPointerDown={event => event.stopPropagation()}
          style={{ left: Math.max(2, Math.min(size.width - 180, contextPoint.x)), top: Math.max(2, Math.min(size.height - 106, contextPoint.y)) }}>
          <button disabled={!validForEdit(chosen[0])} onClick={() => {
            changeObject(chosen[0], { mode: chosen[0].mode === 'card' ? 'direct' : 'card' })
            setContextPoint(undefined)
          }}>{chosen[0].mode === 'card' ? 'Remove Card' : 'Convert to Card'}</button>
          <button disabled={!validForEdit(chosen[0])} onClick={() => { reorder(chosen[0].id, 'front'); setContextPoint(undefined) }}>Bring to front</button>
          <button disabled={!validForEdit(chosen[0])} onClick={() => { reorder(chosen[0].id, 'back'); setContextPoint(undefined) }}>Send to back</button>
        </div>}
        {project.settings.minimap && <Minimap objects={indexed.visible} camera={camera} size={size} onCamera={setCamera} />}
        <div className="ic-zoom" onPointerDown={event => event.stopPropagation()}>
          <button className="ic-icon" aria-label="Zoom out" onClick={() => zoom(camera.zoom / 1.25)}><Minus /></button>
          <div className="ic-anchor"><button className="ic-button ic-zoom-label" aria-label="Zoom settings" aria-expanded={popup === 'zoom'} onClick={() => toggle('zoom')}>{Math.round(camera.zoom * 100)}%</button>
            {popup === 'zoom' && <div className="ic-menu ic-menu-up ic-menu-right">{menuButtons([
              action('Fit All', () => { fit(); setPopup(null) }), action('Fit Selection', () => { fit(true); setPopup(null) }),
              action('Reset to 100%', () => { zoom(1); setPopup(null) }),
            ])}</div>}
          </div>
          <button className="ic-icon" aria-label="Zoom in" onClick={() => zoom(camera.zoom * 1.25)}><Plus /></button>
          <button className="ic-icon" aria-label="Fit All" title="Fit All" onClick={() => fit()}><Maximize /></button>
        </div>
        {panelOpen && <div className="ic-inspector-shell" onPointerDown={event => event.stopPropagation()}><CanvasInspector project={project} selected={chosen} activeEdge={activeEdge}
          select={id => pick(id)} update={changeObject} updateEdge={(edge, patch) => edit(project.objects, project.edges.map(item => item.id === edge.id ? { ...item, ...patch } : item))}
          reorder={reorder} moveIntoFrame={moveIntoFrame} settings={updateSettings} /></div>}
        {(feedback || error) && <div className="ic-toast" role="status" onPointerDown={event => event.stopPropagation()}>{feedback || error}
          {error && <button onClick={() => void flush().catch(onError)}>Retry</button>}<button className="ic-icon" aria-label="Dismiss message" onClick={() => setFeedback('')}><X /></button></div>}
      </>}
      {play && <div className="ic-player" onPointerDown={event => event.stopPropagation()}>
        <button className="ic-button" onClick={() => changeStop(-1)}>Previous</button>
        <span>{play.index + 1} / {project.stops.length} · {project.stops[play.index]?.name}</span>
        <button className="ic-button" onClick={() => changeStop(1)}>Next</button>
        <button className="ic-button" onClick={() => setPlay({ ...play, automatic: !play.automatic })}>{play.automatic ? 'Pause' : 'Auto play'}</button>
        <button className="ic-icon" aria-label="Exit presentation" onClick={() => setPlay(undefined)}><X /></button>
      </div>}
    </div>
    {files && <ImportDialog files={files} close={() => { setFiles(undefined); setReplaceId('') }} onImport={importAssets} />}
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
    {saveModes.some(mode => mode === modal) && <CanvasSaveDialogs mode={modal as typeof saveModes[number]} project={project} projects={projects}
      close={() => setModal(null)} flush={() => flush()} write={write} refresh={async () => { await refresh(); resetHistory(); setSelected([]) }}
      onOpen={id => { setModal(null); openCanvas(id) }} />}
    {modal === 'find' && <CanvasDialog title="Find in canvas" close={() => setModal(null)}>
      <div className="ic-form"><label>Search<input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="ic-row"><label>Scope<select value={findScope} onChange={event => setFindScope(event.target.value)}>
          <option value="canvas">This Canvas</option><option value="children">Include SubCanvases</option><option value="all">All Croft</option></select></label>
          <label>Object type<select value={findKind} onChange={event => setFindKind(event.target.value)}><option value="">All types</option>
            {Object.entries(kinds).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label></div>
        <div className="ic-result-list">{matches.map(({ canvas, object }) => <button key={canvas.id + object.id} onClick={() => {
          setModal(null); if (canvas.id === project.id) jumpTo(object.id); else openCanvas(canvas.id, object.id)
        }}><strong>{object.name}</strong><small>{canvas.name} · {kinds[object.kind]}</small><span>{object.text}</span></button>)}
          {query && !matches.length && <p>No matching canvas objects.</p>}</div>
      </div>
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
    {modal === 'export' && <CanvasDialog title="Export canvas" close={() => { if (!exporting) setModal(null) }}>
      <div className="ic-form"><label>Format<select value={format} onChange={event => setFormat(event.target.value as CanvasExportFormat)}>
        {(['croft', 'zip', 'svg', 'png', 'jpg', 'pdf'] as const).map(item => <option key={item} value={item}>{item === 'croft' ? '.croft editable project' : item.toUpperCase()}</option>)}</select></label>
        <label>Scope<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="canvas">Current Canvas</option>
          <option value="project">Include all SubCanvases</option><option value="selection" disabled={!selected.length}>Selected Objects</option></select></label>
        {!['croft', 'zip'].includes(format) && <label>Background<select value={exportBackground} onChange={event => setExportBackground(event.target.value as typeof exportBackground)}>
          <option value="clean">Clean</option><option value="grid">Include Canvas Background</option>
          <option value="transparent" disabled={format !== 'png' && format !== 'svg'}>Transparent</option></select></label>}
        <p>Packages include imported media. Linked files require re-selection after import.</p>
        <div className="ic-dialog-actions"><button className="ic-button ic-primary" disabled={exporting} onClick={() => {
          setExporting(true)
          const selectedProjects = scope === 'project' ? [project, ...descendants(projects, project.id)] : [project]
          const ids = new Set(selectedProjects.flatMap(item => [item.coverAssetId, ...item.objects.map(object => object.assetId)]).filter((id): id is string => !!id))
          void getAssets(ids).then(assets => exportProject(projects, project.id, format, {
            scope, selectedIds: selected, theme: dark ? 'dark' : 'light', background: exportBackground,
          }, assets)).then(() => setModal(null)).catch(onError).finally(() => setExporting(false))
        }}>{exporting ? 'Exporting…' : 'Export'}</button></div>
        {feedback && <p role="alert">{feedback}</p>}
      </div>
    </CanvasDialog>}
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
          setPlay({ index: 0, automatic: values.has('automatic'), loop: values.has('loop'), smooth: values.has('smooth') })
          void stage.current?.parentElement?.requestFullscreen?.().catch(() => {})
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
    <svg viewBox={`${left} ${upper} ${width} ${height}`} preserveAspectRatio="none" aria-label="Canvas minimap"
      role="button" tabIndex={0} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); centreAt(event) }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) centreAt(event) }}
      onKeyDown={event => {
        if (event.key === 'Enter') onCamera(fitViewport(objects, size, { padding: 75 }))
      }}>
      {local.slice(0, 700).map(item => <rect key={item.id} x={item.x} y={item.y} width={item.width}
        height={item.collapsed ? 36 : item.height} rx={3} fill={item.kind === 'text' ? 'var(--muted)' : item.colour} fillOpacity={.7} />)}
      <rect className="ic-minimap-view" x={top.x} y={top.y} width={Math.max(1, bottom.x - top.x)} height={Math.max(1, bottom.y - top.y)} />
    </svg>
  </div>
}
