import {
  defaultImageEdits, fullImageCrop, imageEffectInsets,
  type ImageEdits, type ImageInsets, type ImageRect, type ImageSize,
} from './imageEdits.ts'

const maximumPixels = 4_000_000
const degreesToRadians = Math.PI / 180
const noInsets = { left: 0, top: 0, right: 0, bottom: 0 }
const inFlight = new Map<string, Promise<HTMLImageElement>>()
const colourSources = new WeakMap<HTMLImageElement, { key: string; pixels: ImageData }>()

export class ImageDimensionsChangedError extends Error {
  constructor() { super('The source dimensions changed. Reopen Crop to apply a new crop or reset the image edits.') }
}

export type ImageSample = { hex: string; r: number; g: number; b: number; alpha: number }
export type RenderedImage = ImageSize & { canvas: HTMLCanvasElement; insets: ImageInsets; scale: number }

export function loadImage(url: string): Promise<HTMLImageElement> {
  const existing = inFlight.get(url)
  if (existing) return existing
  const image = new Image()
  image.decoding = 'async'
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The image could not be decoded.'))
    image.src = url
  })
  inFlight.set(url, request)
  void request.then(() => inFlight.delete(url), () => inFlight.delete(url))
  return request
}

function sourceSize(image: HTMLImageElement): ImageSize {
  const { naturalWidth: width, naturalHeight: height } = image
  if (!width || !height) throw new Error('Invalid image source dimensions.')
  return { width, height }
}

function newCanvas(width: number, height: number, readPixels = false) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  const context = canvas.getContext('2d', { willReadFrequently: readPixels, colorSpace: 'srgb' })
  if (!context) throw new Error('Local image rendering is unavailable in this browser.')
  return { canvas, context }
}

function drawStraightened(context: CanvasRenderingContext2D, image: HTMLImageElement, size: ImageSize, angle: number) {
  context.translate(size.width / 2, size.height / 2)
  context.rotate(angle * degreesToRadians)
  context.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height)
}

export function renderCropSource(image: HTMLImageElement, straighten: number, maxSide = 768) {
  const size = sourceSize(image)
  const scale = Math.min(1, maxSide / Math.max(size.width, size.height))
  const { canvas, context } = newCanvas(size.width * scale, size.height * scale)
  context.scale(canvas.width / size.width, canvas.height / size.height)
  drawStraightened(context, image, size, straighten)
  return canvas
}

function maskBounds(width: number, height: number, shape: ImageEdits['mask']['shape']): ImageRect {
  if (shape === 'circle') {
    const diameter = Math.min(width, height)
    return { x: (width - diameter) / 2, y: (height - diameter) / 2, width: diameter, height: diameter }
  }
  return { x: 0, y: 0, width, height }
}

function positionImage(crop: ImageSize, target: ImageRect, mask: ImageEdits['mask']): ImageRect {
  const scale = (mask.shape === 'none' ? Math.min : Math.max)(target.width / crop.width, target.height / crop.height) * mask.scale
  const width = crop.width * scale
  const height = crop.height * scale
  return {
    x: target.x + (target.width - width) / 2 + mask.x * Math.max(0, width - target.width) / 2,
    y: target.y + (target.height - height) / 2 + mask.y * Math.max(0, height - target.height) / 2,
    width,
    height,
  }
}

function clipBounds(mask: ImageRect, photo: ImageRect): ImageRect {
  const x = Math.max(mask.x, photo.x)
  const y = Math.max(mask.y, photo.y)
  return {
    x, y,
    width: Math.min(mask.x + mask.width, photo.x + photo.width) - x,
    height: Math.min(mask.y + mask.height, photo.y + photo.height) - y,
  }
}

function imagePath(context: CanvasRenderingContext2D, rect: ImageRect, mask: ImageEdits['mask']) {
  context.beginPath()
  const { x, y, width, height } = rect
  if (mask.shape === 'circle' || mask.shape === 'oval') {
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  } else if (mask.shape === 'rounded') {
    context.roundRect(x, y, width, height, Math.min(width, height) * mask.radius / 100)
  } else context.rect(x, y, width, height)
}

function luminance(red: number, green: number, blue: number) {
  return .2126 * red + .7152 * green + .0722 * blue
}

export function applyImageColour(data: Uint8ClampedArray, tone: ImageEdits['tone'], look: ImageEdits['look']) {
  const brightness = tone.brightness * 1.275
  const contrast = 1 + tone.contrast / 100
  const saturation = 1 + tone.saturation / 100
  const warmth = tone.warmth * .55
  const tint = tone.tint * .37
  const intensity = look.name === 'original' ? 0 : look.intensity / 100
  if (!brightness && contrast === 1 && saturation === 1 && !warmth && !tint && !intensity) return

  const fixed = (value: number) => Math.max(0, Math.min(255, value))
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue
    const red = (data[i] - 127.5) * contrast + 127.5 + brightness
    const green = (data[i + 1] - 127.5) * contrast + 127.5 + brightness
    const blue = (data[i + 2] - 127.5) * contrast + 127.5 + brightness
    const grey = luminance(red, green, blue)
    const r = fixed(grey + (red - grey) * saturation + warmth + tint / 2)
    const g = fixed(grey + (green - grey) * saturation - tint)
    const b = fixed(grey + (blue - grey) * saturation - warmth + tint / 2)
    let outR = r
    let outG = g
    let outB = b
    if (intensity) {
      const mono = luminance(r, g, b)
      switch (look.name) {
        case 'black-white': outR = outG = outB = mono; break
        case 'warm': outR = r + 24; outG = g + 7; outB = b - 22; break
        case 'cool': outR = r - 18; outG = g + 3; outB = b + 25; break
        case 'sepia': outR = mono * 1.08 + 18; outG = mono * .91 + 10; outB = mono * .62 + 9; break
        case 'faded': outR = (r + mono) * .34 + 43; outG = (g + mono) * .34 + 43; outB = (b + mono) * .34 + 43; break
      }
    }
    data[i] = r + (fixed(outR) - r) * intensity
    data[i + 1] = g + (fixed(outG) - g) * intensity
    data[i + 2] = b + (fixed(outB) - b) * intensity
  }
}

function needsColour(edits: ImageEdits) {
  return Object.values(edits.tone).some(Boolean) || (edits.look.name !== 'original' && edits.look.intensity > 0)
}

function drawCrop(
  context: CanvasRenderingContext2D, image: HTMLImageElement, size: ImageSize,
  crop: ImageRect, photo: ImageRect, straighten: number, scale: number,
) {
  context.save()
  context.scale(scale, scale)
  // Keep the original oriented source bounds transparent where rotation exposes corners.
  context.beginPath()
  context.rect(photo.x, photo.y, photo.width, photo.height)
  context.clip()
  const fit = photo.width / crop.width
  context.translate(photo.x - crop.x * fit, photo.y - crop.y * fit)
  context.scale(fit, fit)
  drawStraightened(context, image, size, straighten)
  context.restore()
}

function drawPhotograph(
  image: HTMLImageElement, source: ImageSize, crop: ImageRect, photo: ImageRect,
  width: number, height: number, scale: number, settings: ImageEdits,
) {
  const colour = needsColour(settings)
  const result = newCanvas(width * scale, height * scale, colour)
  const { canvas, context } = result
  if (!colour) {
    drawCrop(context, image, source, crop, photo, settings.straighten, scale)
    return result
  }

  // Retain one small geometric sample per decoded source while a slider varies
  // colour. Never cache full exports or final effects under the source key.
  const canCache = canvas.width * canvas.height <= 768 * 768
  const key = [canvas.width, canvas.height, scale, crop.x, crop.y, crop.width, crop.height,
    photo.x, photo.y, photo.width, photo.height, settings.straighten].join(',')
  const cached = canCache ? colourSources.get(image) : undefined
  let original: ImageData
  if (cached?.key === key) original = cached.pixels
  else {
    drawCrop(context, image, source, crop, photo, settings.straighten, scale)
    original = context.getImageData(0, 0, canvas.width, canvas.height)
    if (canCache) colourSources.set(image, { key, pixels: original })
  }
  const edited = canCache ? new ImageData(new Uint8ClampedArray(original.data), original.width, original.height) : original
  applyImageColour(edited.data, settings.tone, settings.look)
  context.putImageData(edited, 0, 0)
  return result
}

export function renderEditedImage(
  image: HTMLImageElement, edits: ImageEdits | undefined,
  options: ImageSize & { maxSide?: number; includeEffects?: boolean },
): RenderedImage {
  const settings = edits ?? defaultImageEdits
  const size = sourceSize(image)
  if (settings.source && (settings.source.width !== size.width || settings.source.height !== size.height)) {
    throw new ImageDimensionsChangedError()
  }
  const frameWidth = Math.max(1, options.width)
  const frameHeight = Math.max(1, options.height)
  const insets = options.includeEffects === false ? noInsets : imageEffectInsets(settings)
  const width = frameWidth + insets.left + insets.right
  const height = frameHeight + insets.top + insets.bottom
  const scale = Math.min(2, (options.maxSide ?? 768) / Math.max(width, height), Math.sqrt(maximumPixels / (width * height)))
  const crop = settings.crop ?? fullImageCrop
  const sourceCrop = { x: crop.x * size.width, y: crop.y * size.height, width: crop.width * size.width, height: crop.height * size.height }
  const mask = maskBounds(frameWidth, frameHeight, settings.mask.shape)
  const photo = positionImage(sourceCrop, mask, settings.mask)
  const clip = settings.mask.shape === 'none' ? clipBounds(mask, photo) : mask
  const pixels = drawPhotograph(image, size, sourceCrop, photo, frameWidth, frameHeight, scale, settings)

  // Mask the image pixels, which lets their alpha define the drop shadow as well.
  pixels.context.save()
  pixels.context.scale(scale, scale)
  pixels.context.globalCompositeOperation = 'destination-in'
  imagePath(pixels.context, clip, settings.mask)
  pixels.context.fill()
  pixels.context.restore()

  const output = newCanvas(width * scale, height * scale)
  const context = output.context
  context.save()
  if (options.includeEffects !== false && settings.shadow.enabled && settings.shadow.opacity) {
    const shadow = settings.shadow
    const opacity = Math.round(shadow.opacity * 2.55).toString(16).padStart(2, '0')
    context.shadowColor = `${shadow.colour}${opacity}`
    context.shadowBlur = shadow.blur * scale
    context.shadowOffsetX = shadow.x * scale
    context.shadowOffsetY = shadow.y * scale
  }
  context.drawImage(pixels.canvas, insets.left * scale, insets.top * scale)
  context.restore()
  if (options.includeEffects !== false && settings.outline.enabled && settings.outline.width) {
    context.scale(scale, scale)
    context.translate(insets.left, insets.top)
    context.strokeStyle = settings.outline.colour
    context.lineWidth = settings.outline.width
    imagePath(context, clip, settings.mask)
    context.stroke()
  }
  return { canvas: output.canvas, insets, width, height, scale }
}

export function sampleRenderedImage(render: RenderedImage, xFraction: number, yFraction: number): ImageSample | undefined {
  if (!Number.isFinite(xFraction) || !Number.isFinite(yFraction) || xFraction < 0 || xFraction > 1 || yFraction < 0 || yFraction > 1) return
  const { canvas, insets, width, height, scale } = render
  const x = insets.left + xFraction * (width - insets.left - insets.right)
  const y = insets.top + yFraction * (height - insets.top - insets.bottom)
  const context = canvas.getContext('2d')
  const pixel = context?.getImageData(Math.min(canvas.width - 1, Math.floor(x * scale)), Math.min(canvas.height - 1, Math.floor(y * scale)), 1, 1).data
  if (!pixel?.[3]) return
  const [r, g, b, alpha] = pixel
  const hex = '#' + [r, g, b].map(component => component.toString(16).padStart(2, '0')).join('')
  return { hex, r, g, b, alpha: Math.round(alpha / 255 * 1000) / 1000 }
}
