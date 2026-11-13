import type { ImageSize } from './imageEdits'

export const imagePreviewLimits = {
  side: 2304,
  imagePixels: 3 * 1024 * 1024,
  pagePixels: 6 * 1024 * 1024,
} as const

export type PreviewRaster = ImageSize & { scale: number }
type PreviewPaint = (raster: PreviewRaster) => boolean
type PreviewRequest = ImageSize & { scale: number; paint: PreviewPaint }
type PreviewSlot = { request?: PreviewRequest; painted?: PreviewRaster & { paint: PreviewPaint }; clear: () => void }

function rasterFor(request: PreviewRequest, maxPixels: number): PreviewRaster {
  const { width, height } = request
  const longSide = Math.max(width, height)
  // The long side is also limited by maxPixels when the short side rounds to one pixel.
  const scale = Math.min(request.scale, imagePreviewLimits.side / longSide, maxPixels / longSide, Math.sqrt(maxPixels / (width * height)))
  return { scale, width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

const slots = new Set<PreviewSlot>()
let frame: number | undefined
let allocated: { slot: PreviewSlot; request: PreviewRequest; raster: PreviewRaster }[] = []
let needsAllocation = false
const area = ({ width, height }: ImageSize) => width * height

function clearSlot(slot: PreviewSlot) {
  slot.clear()
  slot.painted = undefined
}

function schedulePaint() {
  if (frame === undefined) frame = requestAnimationFrame(paintNext)
}

function paintNext() {
  frame = undefined
  if (needsAllocation) {
    needsAllocation = false
    let available = imagePreviewLimits.pagePixels as number
    const demands = [...slots].flatMap(slot => slot.request ? [{ slot, request: slot.request,
      target: rasterFor(slot.request, imagePreviewLimits.imagePixels) }] : [])
      .sort((first, second) => area(first.target) - area(second.target))
    // Satisfy small previews first, then give equally sized shares to the larger images.
    allocated = demands.map(({ slot, request, target }, index) => {
      const share = Math.floor(available / (demands.length - index))
      const raster = area(target) <= share ? target : rasterFor(request, share)
      available -= area(raster)
      return { slot, request, raster }
    })
  }

  const next = allocated.find(({ slot }) => !slot.painted) ?? allocated.find(({ slot, request, raster }) =>
    slot.painted?.paint !== request.paint || slot.painted.scale !== raster.scale)
  if (!next) return

  let remaining = imagePreviewLimits.pagePixels - area(next.raster)
  for (const { slot } of allocated) if (slot !== next.slot && slot.painted) remaining -= area(slot.painted)
  for (const { slot, raster } of allocated) {
    if (remaining >= 0) break
    if (slot !== next.slot && slot.painted && area(slot.painted) > area(raster)) {
      remaining += area(slot.painted)
      clearSlot(slot)
    }
  }

  // Keep the old canvas until its replacement is ready. One paint per frame
  // bounds the extra live output, scratch canvas and temporary colour buffer.
  const painted = next.request.paint(next.raster)
  next.slot.painted = { ...next.raster, paint: next.request.paint, ...(!painted && { width: 0, height: 0 }) }
  schedulePaint()
}

export function createImagePreview(clear: () => void) {
  const slot: PreviewSlot = { clear }
  slots.add(slot)
  return {
    request(request: PreviewRequest) {
      slot.request = request
      needsAllocation = true
      schedulePaint()
    },
    resize(scale: number) {
      if (!slot.request || slot.request.scale === scale) return
      slot.request = { ...slot.request, scale }
      needsAllocation = true
      schedulePaint()
    },
    dispose() {
      slots.delete(slot)
      clearSlot(slot)
      needsAllocation = true
      if (slots.size) schedulePaint()
      else {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        allocated = []
      }
    },
  }
}
