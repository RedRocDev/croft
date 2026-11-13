import type { OrientedRect } from './geometry'

export type Point = { x: number; y: number }
export type Camera = Point & { zoom: number }
export type ObjectKind = 'text' | 'note' | 'rectangle' | 'ellipse' | 'stroke' | 'image' | 'audio' | 'video' | 'file' | 'canvas' | 'frame' | 'group' | 'stack' | 'page'
export type CardSide = 'front' | 'back'
export type CardFace = { title: string; text: string; assetId?: string }
export type TextAlignment = 'left' | 'center' | 'right'
export type StackLayout = 'compact' | 'fan'
export type EdgeKind = 'direction' | 'connection' | 'relationship'
export type Grid = 'dots' | 'lines' | 'none'
export type CanvasObject = Point & {
  id: string; kind: ObjectKind; width: number; height: number; rotation: number; opacity: number
  hidden: boolean; locked: boolean; name: string; text: string; colour: string; mode: 'direct' | 'card'
  parentId?: string; assetId?: string; targetId?: string; points?: Point[]; strokeWidth?: number
  collapsed?: boolean; caption?: string; border?: boolean; referenceOnly?: boolean; textAlign?: TextAlignment
  /** Frame bounds before automatic growth, in the same world coordinates as the frame. */
  frameBase?: OrientedRect
  back?: CardFace; visibleSide?: CardSide
  stack?: { order: string[]; layout: StackLayout }
}
export type CanvasEdge = { id: string; kind: EdgeKind; from: string; to: string; label: string }
export type PresentationStop = { id: string; name: string; canvasId: string; camera: Camera; duration: number }
export type CanvasSettings = {
  grid: Grid; minimap: boolean; snapGrid: boolean; snapObjects: boolean; guides: boolean
  showEdges: Record<EdgeKind, boolean>; toolbar: 'floating' | 'parked'; toolbarPoint: Point
  panel: 'properties' | 'layers' | 'closed'
}
export type CanvasProject = {
  id: string; parentId: string | null; name: string; description: string; icon: string; coverAssetId?: string; iconAssetId?: string
  trashedAt?: number
  createdAt: number; updatedAt: number; camera: Camera; settings: CanvasSettings
  objects: CanvasObject[]; edges: CanvasEdge[]; stops: PresentationStop[]
}
export type CanvasAsset = { id: string; name: string; mime: string; size: number; blob?: Blob; handle?: FileSystemFileHandle; linked?: boolean }
export type Placement = 'smart' | 'free'

export const palette = ['#f5e7a5', '#cfe9d8', '#dbe7fa', '#eddcf5', '#f5dcd4', '#f0eee9', '#335e4c']
export const projectIcons = ['◈', '✦', '⌂', '✿', '◎', '▦']
export const kinds: Record<ObjectKind, string> = {
  text: 'Text', note: 'Sticky note', rectangle: 'Rectangle', ellipse: 'Ellipse', stroke: 'Drawing',
  image: 'Image', audio: 'Audio', video: 'Video', file: 'File', canvas: 'SubCanvas',
  frame: 'Frame', group: 'Group', stack: 'Card stack', page: 'Croft page',
}
export const edgeLabels: Record<EdgeKind, string> = { direction: 'Directions', connection: 'Connections', relationship: 'Relationships' }

export function canFlip(object: CanvasObject) {
  return object.kind === 'note' || (object.mode === 'card' && !['frame', 'group', 'stack'].includes(object.kind))
}

export function cardSide(object: CanvasObject): CardSide {
  return canFlip(object) && object.visibleSide === 'back' ? 'back' : 'front'
}

export function cardFace(object: CanvasObject, side = cardSide(object)): CardFace {
  return side === 'back' ? object.back ?? { title: '', text: '' } : { title: object.name, text: object.text, assetId: object.assetId }
}

export function objectAssetIds(object: CanvasObject) {
  return [object.assetId, object.back?.assetId].filter((id): id is string => !!id)
}

export type CardSearchResult = { object: CanvasObject; side?: CardSide; title: string; location: string; description: string }

export function searchCanvasObjects(project: CanvasProject, query: string, kind?: string): CardSearchResult[] {
  const term = query.trim().toLowerCase()
  if (!term) return []
  const byId = new Map(project.objects.map(object => [object.id, object]))
  const results: CardSearchResult[] = []
  for (const object of project.objects) {
    if (kind && kind !== object.kind) continue
    const parent = object.parentId ? byId.get(object.parentId) : undefined
    const location = parent?.kind === 'stack' ? `${project.name} / ${parent.name}` : project.name
    const matches = (...entries: (string | undefined)[]) => entries.join(' ').toLowerCase().includes(term)
    if (matches(object.name, object.text, object.caption)) {
      const side = canFlip(object) ? 'front' : undefined
      results.push({ object, side, title: object.name, location: side ? `${location} · Front` : location, description: object.text })
    }
    if (object.back && matches(object.back.title, object.back.text)) {
      results.push({ object, side: 'back', title: object.back.title ? `${object.name} · ${object.back.title}` : object.name,
        location: `${location} · Back`, description: object.back.text })
    }
  }
  return results
}

export function createProject(name: string, parentId: string | null = null): CanvasProject {
  const now = Date.now()
  return {
    id: crypto.randomUUID(), parentId, name, description: '', icon: projectIcons[0],
    createdAt: now, updatedAt: now, camera: { x: 0, y: 0, zoom: 1 },
    settings: {
      grid: 'dots', minimap: true, snapGrid: true, snapObjects: true, guides: true,
      showEdges: { direction: true, connection: true, relationship: true },
      toolbar: 'floating', toolbarPoint: { x: .5, y: .02 }, panel: 'properties',
    },
    objects: [], edges: [], stops: [],
  }
}

export function makeObject(kind: ObjectKind, point: Point, options?: Partial<CanvasObject>): CanvasObject {
  const size = kind === 'frame' ? { width: 420, height: 270 } : kind === 'canvas' ? { width: 240, height: 165 } :
    kind === 'audio' || kind === 'file' ? { width: 280, height: 108 } :
      kind === 'text' ? { width: 225, height: 90 } : { width: 210, height: 140 }
  return {
    id: crypto.randomUUID(), kind, ...point, ...size, rotation: 0, opacity: 1, hidden: false,
    locked: false, name: kinds[kind], text: '', colour: kind === 'note' ? palette[0] : palette[1],
    mode: ['note', 'canvas', 'audio', 'video', 'file', 'page'].includes(kind) ? 'card' : 'direct', ...options,
  }
}

export function ancestors(projects: CanvasProject[], id: string) {
  const byId = new Map(projects.map(project => [project.id, project]))
  const chain: CanvasProject[] = []
  const seen = new Set<string>()
  let entry = byId.get(id)
  while (entry && !seen.has(entry.id)) {
    chain.push(entry)
    seen.add(entry.id)
    entry = entry.parentId ? byId.get(entry.parentId) : undefined
  }
  return chain.reverse()
}

export function descendants(projects: CanvasProject[], rootId: string) {
  const children = new Map<string, CanvasProject[]>()
  for (const project of projects) {
    if (!project.parentId) continue
    const entries = children.get(project.parentId) ?? []
    entries.push(project)
    children.set(project.parentId, entries)
  }
  const found: CanvasProject[] = []
  const queue = [rootId]
  const seen = new Set(queue)
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      found.push(child)
      queue.push(child.id)
    }
  }
  return found
}

export function objectFlags(object: CanvasObject, objects: ReadonlyMap<string, CanvasObject>) {
  let hidden = object.hidden
  let locked = object.locked
  let parentId = object.parentId
  const seen = new Set([object.id])
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = objects.get(parentId)
    if (!parent) break
    hidden ||= parent.hidden || !!parent.collapsed
    locked ||= parent.locked
    parentId = parent.parentId
  }
  return { hidden, locked }
}

export function seedProjects(): CanvasProject[] {
  const root = { ...createProject('Holiday Ideas'), description: 'A visual itinerary for a long weekend in Paris.', icon: '✦' }
  const hotels = { ...createProject('Hotels', root.id), description: 'Places to stay and neighbourhood notes.', icon: '⌂' }
  const paris = { ...createProject('Paris Hotels', hotels.id), icon: '◎' }
  const title = makeObject('text', { x: 0, y: 0 }, { width: 420, height: 82, name: 'Weekend in Paris', text: 'Weekend in Paris' })
  const note = makeObject('note', { x: 0, y: 110 }, { width: 232, height: 160, name: 'The plan', text: 'Three nights in Paris.\n\nFind a quiet base near a Métro stop and leave Sunday open for exploring.' })
  const list = makeObject('note', { x: 265, y: 110 }, { width: 215, height: 158, name: 'Places to visit', colour: palette[2], text: 'Musée d’Orsay\nCanal Saint-Martin\nJardin du Luxembourg' })
  const tile = makeObject('canvas', { x: 520, y: 110 }, { targetId: hotels.id, name: hotels.name })
  const frame = makeObject('frame', { x: -20, y: 315 }, { width: 520, height: 220, name: 'Travel notes', colour: palette[5] })
  const travel = makeObject('note', { x: 5, y: 365 }, { parentId: frame.id, name: 'Getting there', colour: palette[1], text: 'Compare the first train on Friday with the evening service.' })
  const page = makeObject('page', { x: 265, y: 366 }, { parentId: frame.id, targetId: 'handbook', name: 'Studio handbook', text: 'Croft page' })
  root.objects = [frame, title, note, list, tile, travel, page]
  root.edges = [
    { id: crypto.randomUUID(), kind: 'direction', from: note.id, to: list.id, label: '' },
    { id: crypto.randomUUID(), kind: 'relationship', from: list.id, to: tile.id, label: 'Stay nearby' },
  ]
  hotels.objects = [
    makeObject('note', { x: 30, y: 45 }, { name: 'Which area?', text: 'Look near Le Marais or the Latin Quarter.', colour: palette[2] }),
    makeObject('canvas', { x: 330, y: 45 }, { targetId: paris.id, name: paris.name }),
  ]
  paris.objects = [makeObject('note', { x: 35, y: 45 }, { name: 'Hotel shortlist', text: 'Check availability, proximity to the Métro and late check-in.' })]
  return [root, hotels, paris]
}
