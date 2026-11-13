export type ImageSize = { width: number; height: number }
export type ImageRect = ImageSize & { x: number; y: number }
export type ImageInsets = { left: number; top: number; right: number; bottom: number }
export const imageLookNames = ['original', 'black-white', 'warm', 'cool', 'sepia', 'faded'] as const
export const imageMaskShapes = ['none', 'circle', 'oval', 'rounded'] as const
export type ImageLook = typeof imageLookNames[number]
export type ImageMaskShape = typeof imageMaskShapes[number]

export type ImageEdits = {
  version: 1
  source?: ImageSize
  crop?: ImageRect
  straighten: number
  tone: { brightness: number; contrast: number; saturation: number; warmth: number; tint: number }
  look: { name: ImageLook; intensity: number }
  mask: { shape: ImageMaskShape; radius: number; x: number; y: number; scale: number }
  outline: { enabled: boolean; colour: string; width: number }
  shadow: { enabled: boolean; colour: string; opacity: number; x: number; y: number; blur: number }
}

export const fullImageCrop: ImageRect = { x: 0, y: 0, width: 1, height: 1 }

export const defaultImageEdits: ImageEdits = {
  version: 1,
  straighten: 0,
  tone: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, tint: 0 },
  look: { name: 'original', intensity: 100 },
  mask: { shape: 'none', radius: 12, x: 0, y: 0, scale: 1 },
  outline: { enabled: false, colour: '#ffffff', width: 2 },
  shadow: { enabled: false, colour: '#171d1a', opacity: 38, x: 3, y: 7, blur: 8 },
}

function fields(value: unknown, names: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) {
    throw new Error(`Invalid image ${label}.`)
  }
  return value as Record<string, unknown>
}

function number(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid image ${label}.`)
  }
  return value
}

function option<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`Invalid image ${label}.`)
  return value as T
}

function enabled(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Invalid image effect switch.')
  return value
}

function colour(value: unknown) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('Invalid image effect colour.')
  return value.toLowerCase()
}

export function readImageEdits(value: unknown): ImageEdits {
  const edit = fields(value, ['version', 'source', 'crop', 'straighten', 'tone', 'look', 'mask', 'outline', 'shadow'], 'edits')
  if (edit.version !== 1) throw new Error('Unsupported image edit version.')
  const tone = fields(edit.tone, ['brightness', 'contrast', 'saturation', 'warmth', 'tint'], 'adjustments')
  const look = fields(edit.look, ['name', 'intensity'], 'look')
  const mask = fields(edit.mask, ['shape', 'radius', 'x', 'y', 'scale'], 'mask')
  const outline = fields(edit.outline, ['enabled', 'colour', 'width'], 'outline')
  const shadow = fields(edit.shadow, ['enabled', 'colour', 'opacity', 'x', 'y', 'blur'], 'shadow')
  let source: ImageSize | undefined
  let crop: ImageRect | undefined
  if (edit.source !== undefined) {
    const size = fields(edit.source, ['width', 'height'], 'source dimensions')
    const width = number(size.width, 1, 1_000_000, 'source width')
    const height = number(size.height, 1, 1_000_000, 'source height')
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('Invalid image source dimensions.')
    source = { width, height }
  }
  if (edit.crop !== undefined) {
    const bounds = fields(edit.crop, ['x', 'y', 'width', 'height'], 'crop')
    const x = number(bounds.x, 0, .99, 'crop X')
    const y = number(bounds.y, 0, .99, 'crop Y')
    const width = number(bounds.width, .01, 1, 'crop width')
    const height = number(bounds.height, .01, 1, 'crop height')
    if (x + width > 1 + 1e-8 || y + height > 1 + 1e-8) throw new Error('Image crop extends outside the source.')
    crop = { x, y, width, height }
  }
  return {
    version: 1,
    ...(source && { source }),
    ...(crop && { crop }),
    straighten: number(edit.straighten, -45, 45, 'straightening angle'),
    tone: {
      brightness: number(tone.brightness, -100, 100, 'brightness'),
      contrast: number(tone.contrast, -100, 100, 'contrast'),
      saturation: number(tone.saturation, -100, 100, 'saturation'),
      warmth: number(tone.warmth, -100, 100, 'warmth'),
      tint: number(tone.tint, -100, 100, 'tint'),
    },
    look: { name: option(look.name, imageLookNames, 'look'), intensity: number(look.intensity, 0, 100, 'look intensity') },
    mask: {
      shape: option(mask.shape, imageMaskShapes, 'mask shape'),
      radius: number(mask.radius, 0, 50, 'mask radius'),
      x: number(mask.x, -1, 1, 'image offset X'),
      y: number(mask.y, -1, 1, 'image offset Y'),
      scale: number(mask.scale, 1, 3, 'image scale'),
    },
    outline: { enabled: enabled(outline.enabled), colour: colour(outline.colour), width: number(outline.width, 0, 50, 'outline width') },
    shadow: {
      enabled: enabled(shadow.enabled), colour: colour(shadow.colour), opacity: number(shadow.opacity, 0, 100, 'shadow opacity'),
      x: number(shadow.x, -100, 100, 'shadow X'), y: number(shadow.y, -100, 100, 'shadow Y'), blur: number(shadow.blur, 0, 60, 'shadow blur'),
    },
  }
}

export function imageEffectInsets(edits?: ImageEdits): ImageInsets {
  const outline = edits?.outline.enabled && edits.outline.width ? Math.ceil(edits.outline.width / 2 + 1) : 0
  const shadow = edits?.shadow
  if (!shadow?.enabled || !shadow.opacity) return { left: outline, top: outline, right: outline, bottom: outline }
  const radius = Math.ceil(shadow.blur * 2 + 2)
  return {
    left: outline + Math.max(0, Math.ceil(radius - shadow.x)),
    top: outline + Math.max(0, Math.ceil(radius - shadow.y)),
    right: outline + Math.max(0, Math.ceil(radius + shadow.x)),
    bottom: outline + Math.max(0, Math.ceil(radius + shadow.y)),
  }
}

export function imageFrameSize(object: ImageSize & { mode: 'direct' | 'card'; caption?: string; border?: boolean }, side: 'front' | 'back'): ImageRect {
  if (side === 'back') return {
    x: 12, y: object.height * .45, width: Math.max(1, object.width - 26), height: Math.min(150, Math.max(1, object.height - object.height * .45 - 8)),
  }
  const border = object.mode === 'card' ? 1 : object.border ? 2 : 0
  const title = object.mode === 'card' ? 26 : 0
  const caption = object.mode === 'card' && object.caption ? 20 : 0
  return {
    x: border, y: border + title,
    width: Math.max(1, object.width - border * 2), height: Math.max(1, object.height - border * 2 - title - caption),
  }
}
