import { fullImageCrop, type ImageEdits } from './imageEdits.ts'

export type CropArea = NonNullable<ImageEdits['crop']>
export type CropHandle = 'move' | 'north-west' | 'north-east' | 'south-west' | 'south-east'
export const fullCrop = fullImageCrop
const cropMinimum = .01

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** The aspect is expressed in normalized coordinates, after dividing by the source aspect. */
export function fitCrop(rect: CropArea, aspect: number | undefined): CropArea {
  if (!aspect) return rect
  if (rect.width / rect.height > aspect) {
    const width = rect.height * aspect
    if (width >= cropMinimum) return { ...rect, x: rect.x + (rect.width - width) / 2, width }
  } else {
    const height = rect.width / aspect
    if (height >= cropMinimum) return { ...rect, y: rect.y + (rect.height - height) / 2, height }
  }
  const width = Math.max(cropMinimum, cropMinimum * aspect)
  const height = width / aspect
  if (width > 1 || height > 1) return rect
  return { x: clamp(rect.x + (rect.width - width) / 2, 0, 1 - width), y: clamp(rect.y + (rect.height - height) / 2, 0, 1 - height), width, height }
}

export function moveCrop(rect: CropArea, handle: CropHandle, dx: number, dy: number, aspect?: number): CropArea {
  if (handle === 'move') {
    return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.width), y: clamp(rect.y + dy, 0, 1 - rect.height) }
  }
  const right = handle.endsWith('east')
  const bottom = handle.startsWith('south')
  const anchorX = right ? rect.x : rect.x + rect.width
  const anchorY = bottom ? rect.y : rect.y + rect.height
  const maxWidth = right ? 1 - anchorX : anchorX
  const maxHeight = bottom ? 1 - anchorY : anchorY
  const widthChange = right ? dx : -dx
  const heightChange = bottom ? dy : -dy
  let width = clamp(rect.width + widthChange, cropMinimum, maxWidth)
  let height = clamp(rect.height + heightChange, cropMinimum, maxHeight)
  if (aspect) {
    const maxFixedWidth = Math.min(maxWidth, maxHeight * aspect)
    const minFixedWidth = Math.max(cropMinimum, cropMinimum * aspect)
    if (maxFixedWidth + 1e-10 < minFixedWidth) return rect
    const change = Math.abs(widthChange) >= Math.abs(heightChange * aspect) ? widthChange : heightChange * aspect
    width = clamp(rect.width + change, minFixedWidth, maxFixedWidth)
    height = width / aspect
  }
  return { x: right ? anchorX : Math.max(0, anchorX - width), y: bottom ? anchorY : Math.max(0, anchorY - height), width, height }
}

export function isFullCrop(rect: CropArea) {
  return Math.abs(rect.x) < 1e-8 && Math.abs(rect.y) < 1e-8 && Math.abs(rect.width - 1) < 1e-8 && Math.abs(rect.height - 1) < 1e-8
}
