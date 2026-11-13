export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

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

// Zoom is measured in screen pixels per world unit. These limits allow 5–800%.
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 8
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

export function connectionEndpoints(from: Rect, to: Rect): { from: Point; to: Point } {
  return { from: rectCenter(from), to: rectCenter(to) }
}
