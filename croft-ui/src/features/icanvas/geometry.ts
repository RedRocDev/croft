export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}
export interface OrientedRect extends Rect { rotation: number }

export interface Viewport extends Point {
  zoom: number
}

export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ZoomLimits {
  min?: number
  max?: number
}

export interface FitOptions extends ZoomLimits {
  padding?: number
}

export type PlacementMode = 'smart' | 'free'

// Zoom is measured in screen pixels per world unit. These limits allow 0.25–6400%.
export const MIN_ZOOM = 0.0025
export const MAX_ZOOM = 64
export const GRID_SPACING = 24

function clampZoom(zoom: number, { min = MIN_ZOOM, max = MAX_ZOOM }: ZoomLimits): number {
  return Math.max(min, Math.min(max, zoom))
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  }
}

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  }
}

export function zoomAt(viewport: Viewport, cursor: Point, zoom: number, limits: ZoomLimits = {}): Viewport {
  const nextZoom = clampZoom(zoom, limits)
  if (viewport.zoom === nextZoom) return viewport

  const anchor = screenToWorld(cursor, viewport)
  return {
    x: cursor.x - anchor.x * nextZoom,
    y: cursor.y - anchor.y * nextZoom,
    zoom: nextZoom,
  }
}

export function pinchViewport(viewport: Viewport, initialCenter: Point, center: Point, ratio: number): Viewport {
  const zoomed = zoomAt(viewport, initialCenter, viewport.zoom * ratio)
  return { x: zoomed.x + center.x - initialCenter.x, y: zoomed.y + center.y - initialCenter.y, zoom: zoomed.zoom }
}

/** Keep compositor coordinates small without changing persisted world coordinates. */
export function renderOrigin(viewport: Viewport): Point {
  const topLeft = screenToWorld({ x: 0, y: 0 }, viewport)
  const localize = (value: number) => Math.abs(value) < 15_000 ? 0 : Math.floor(value / 4096) * 4096
  return { x: localize(topLeft.x), y: localize(topLeft.y) }
}

export function gridAtZoom(zoom: number): number {
  const coarse = Math.max(0, Math.ceil(Math.log(8 / (GRID_SPACING * zoom)) / Math.log(4)))
  return GRID_SPACING * 4 ** coarse * zoom
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

export function rotatedBounds(rect: Rect, rotation = 0): Bounds {
  if (rotation % 360 === 0) {
    return {
      left: Math.min(rect.x, rect.x + rect.width),
      top: Math.min(rect.y, rect.y + rect.height),
      right: Math.max(rect.x, rect.x + rect.width),
      bottom: Math.max(rect.y, rect.y + rect.height),
    }
  }

  const center = rectCenter(rect)
  const radians = (rotation % 360) * Math.PI / 180
  const cosine = Math.abs(Math.cos(radians))
  const sine = Math.abs(Math.sin(radians))
  const halfWidth = (Math.abs(rect.width) * cosine + Math.abs(rect.height) * sine) / 2
  const halfHeight = (Math.abs(rect.width) * sine + Math.abs(rect.height) * cosine) / 2

  return {
    left: center.x - halfWidth,
    top: center.y - halfHeight,
    right: center.x + halfWidth,
    bottom: center.y + halfHeight,
  }
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

export function intersects(a: Rect, b: Rect): boolean {
  return boundsIntersect(rotatedBounds(a), rotatedBounds(b))
}

export function fitViewport(
  items: readonly (Rect & { rotation?: number })[],
  size: Size,
  options: FitOptions = {},
): Viewport {
  if (items.length === 0) {
    return { x: size.width / 2, y: size.height / 2, zoom: clampZoom(1, options) }
  }

  const bounds = rotatedBounds(items[0], items[0].rotation)
  for (let index = 1; index < items.length; index += 1) {
    const item = items[index]
    const next = rotatedBounds(item, item.rotation)
    bounds.left = Math.min(bounds.left, next.left)
    bounds.top = Math.min(bounds.top, next.top)
    bounds.right = Math.max(bounds.right, next.right)
    bounds.bottom = Math.max(bounds.bottom, next.bottom)
  }

  const padding = options.padding ?? 48
  const horizontalPadding = Math.min(Math.max(0, padding), Math.max(0, (size.width - 1) / 2))
  const verticalPadding = Math.min(Math.max(0, padding), Math.max(0, (size.height - 1) / 2))
  const width = Math.max(1, bounds.right - bounds.left)
  const height = Math.max(1, bounds.bottom - bounds.top)
  const zoom = clampZoom(Math.min(
    Math.max(1, size.width - 2 * horizontalPadding) / width,
    Math.max(1, size.height - 2 * verticalPadding) / height,
  ), options)

  return {
    x: (size.width - (bounds.left + bounds.right) * zoom) / 2,
    y: (size.height - (bounds.top + bounds.bottom) * zoom) / 2,
    zoom,
  }
}

/** Overscan is expressed in screen pixels so its visual extent stays stable during zoom. */
export function visibleInViewport(
  rect: Rect,
  viewport: Viewport,
  size: Size,
  rotation = 0,
  overscan = 0,
): boolean {
  const margin = Math.max(0, overscan)
  const first = screenToWorld({ x: -margin, y: -margin }, viewport)
  const last = screenToWorld({ x: size.width + margin, y: size.height + margin }, viewport)
  return boundsIntersect(rotatedBounds(rect, rotation), {
    left: first.x,
    top: first.y,
    right: last.x,
    bottom: last.y,
  })
}

export function snapPoint(point: Point, spacing = GRID_SPACING): Point {
  if (!Number.isFinite(spacing) || spacing <= 0) return point

  const snap = (value: number) => (Math.sign(value) * Math.round(Math.abs(value) / spacing) * spacing) || 0
  return { x: snap(point.x), y: snap(point.y) }
}

export function placePoint(point: Point, mode: PlacementMode, spacing = GRID_SPACING): Point {
  return mode === 'smart' ? snapPoint(point, spacing) : point
}

export function objectSnap(moving: Rect, neighbours: readonly Rect[], tolerance: number): { point: Point; axes: { x: boolean; y: boolean } } {
  function axis(start: 'x' | 'y', size: 'width' | 'height', across: 'x' | 'y', depth: 'width' | 'height') {
    let delta = 0
    let best = tolerance
    const consider = (proposed: number) => {
      const change = proposed - moving[start]
      if (Math.abs(change) < best) { best = Math.abs(change); delta = change }
    }
    for (const target of neighbours) {
      for (const anchor of [target[start], target[start] + target[size] / 2, target[start] + target[size]]) {
        for (const offset of [0, moving[size] / 2, moving[size]]) consider(anchor - offset)
      }
    }
    const row = neighbours.filter(target => target[across] < moving[across] + moving[depth] && target[across] + target[depth] > moving[across])
      .sort((a, b) => a[start] - b[start])
    for (let index = 1; index < row.length; index++) {
      const left = row[index - 1]
      const right = row[index]
      const leftEnd = left[start] + left[size]
      const gap = right[start] - leftEnd
      if (gap <= 0) continue
      consider(left[start] - gap - moving[size])
      consider(right[start] + right[size] + gap)
      if (gap >= moving[size]) consider(leftEnd + (gap - moving[size]) / 2)
    }
    return { value: moving[start] + delta, snapped: best < tolerance }
  }
  const x = axis('x', 'width', 'y', 'height')
  const y = axis('y', 'height', 'x', 'width')
  return { point: { x: x.value, y: y.value }, axes: { x: x.snapped, y: y.snapped } }
}

/** Similarity transforms fit our position/size/rotation model without introducing shear. */
export function transformDescendant<T extends Rect & { rotation: number; points?: Point[] }>(
  child: T, before: Rect & { rotation: number }, after: Rect & { rotation: number }, scale: number,
): T {
  const origin = rectCenter(before)
  const target = rectCenter(after)
  const centre = rectCenter(child)
  const angle = (after.rotation - before.rotation) * Math.PI / 180
  const x = (centre.x - origin.x) * scale
  const y = (centre.y - origin.y) * scale
  const width = child.width * scale
  const height = child.height * scale
  return { ...child, x: target.x + x * Math.cos(angle) - y * Math.sin(angle) - width / 2,
    y: target.y + x * Math.sin(angle) + y * Math.cos(angle) - height / 2, width, height,
    rotation: (child.rotation + after.rotation - before.rotation) % 360,
    points: scale === 1 ? child.points : child.points?.map(point => ({ x: point.x * scale, y: point.y * scale })) }
}

function frameLocalBounds(frame: OrientedRect, child: OrientedRect): Bounds {
  const center = rectCenter(frame)
  const childCenter = rectCenter(child)
  const angle = frame.rotation * Math.PI / 180
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const dx = childCenter.x - center.x, dy = childCenter.y - center.y
  const x = dx * cos + dy * sin + frame.width / 2 - child.width / 2
  const y = -dx * sin + dy * cos + frame.height / 2 - child.height / 2
  return rotatedBounds({ ...child, x, y }, child.rotation - frame.rotation)
}

function frameWithBounds<T extends OrientedRect>(frame: T, { left, top, right, bottom }: Bounds): T {
  if (Math.max(Math.abs(left), Math.abs(top), Math.abs(right - frame.width), Math.abs(bottom - frame.height)) < 1e-8) return frame
  const center = rectCenter(frame)
  const angle = frame.rotation * Math.PI / 180
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const shiftX = (left + right - frame.width) / 2, shiftY = (top + bottom - frame.height) / 2
  const width = right - left, height = bottom - top
  return { ...frame, x: center.x + shiftX * cos - shiftY * sin - width / 2, y: center.y + shiftX * sin + shiftY * cos - height / 2, width, height }
}

export function fitFrameAround<T extends OrientedRect>(frame: T, child: OrientedRect): T {
  const bounds = frameLocalBounds(frame, child)
  return frameWithBounds(frame, { left: Math.min(0, bounds.left - 24), right: Math.max(frame.width, bounds.right + 24),
    top: Math.min(0, bounds.top - 32), bottom: Math.max(frame.height, bounds.bottom + 24) })
}

export function fitFrameToContents<T extends OrientedRect>(frame: T, children: readonly OrientedRect[]): T {
  if (!children.length) return frame
  const first = frameLocalBounds(frame, children[0])
  const bounds = children.slice(1).reduce((area, child) => {
    const next = frameLocalBounds(frame, child)
    return { left: Math.min(area.left, next.left), top: Math.min(area.top, next.top),
      right: Math.max(area.right, next.right), bottom: Math.max(area.bottom, next.bottom) }
  }, first)
  return frameWithBounds(frame, { left: bounds.left - 24, top: bounds.top - 32, right: bounds.right + 24, bottom: bounds.bottom + 24 })
}
export function containsPoint(rect: Rect & { rotation: number }, point: Point) {
  const center = rectCenter(rect)
  const angle = rect.rotation * Math.PI / 180
  const x = point.x - center.x, y = point.y - center.y
  return Math.abs(x * Math.cos(angle) + y * Math.sin(angle)) <= rect.width / 2 &&
    Math.abs(-x * Math.sin(angle) + y * Math.cos(angle)) <= rect.height / 2
}

export function connectionEndpoints(from: Rect, to: Rect): { from: Point; to: Point } {
  return { from: rectCenter(from), to: rectCenter(to) }
}
