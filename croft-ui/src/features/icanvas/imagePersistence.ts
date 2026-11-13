import { readImageEdits } from './imageEdits.ts'
import type { CanvasAsset, CanvasProject, ProjectSwatch } from './model.ts'
import { containsCardExtensions } from './stackPersistence.ts'
import { readSmartlink } from './smartlinks.ts'

export const maxProjectSwatches = 48
export const maxSwatchNameLength = 80

export type CanvasFormatVersion = 1 | 2 | 3 | 4 | 5

export function readProjectSwatches(value: unknown): ProjectSwatch[] {
  if (!Array.isArray(value) || value.length > maxProjectSwatches) throw new Error('Invalid project swatch list.')
  const ids = new Set<string>()
  return value.map(entry => {
    const { id, name, colour } = entry ?? {}
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || ids.has(id) ||
        typeof name !== 'string' || !name.trim() || name.length > maxSwatchNameLength ||
        typeof colour !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(colour)) {
      throw new Error('Invalid or duplicate project swatch.')
    }
    ids.add(id)
    return { id, name, colour }
  })
}

export function assertCanvasImageMetadata(project: CanvasProject) {
  if (project.swatches !== undefined) readProjectSwatches(project.swatches)
  const checkColour = (colour: unknown) => {
    if (colour !== undefined && (typeof colour !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(colour))) {
      throw new Error('Invalid text or connector colour.')
    }
  }
  for (const edge of project.edges) checkColour(edge.colour)
  for (const item of project.objects) {
    checkColour(item.textColour)
    if (item.smartlink !== undefined) readSmartlink(item.smartlink)
    if (item.kind === 'smartlink' && item.smartlink === undefined) throw new Error('Smartlink objects require validated link content.')
    if (item.smartlink && item.assetId) throw new Error('A card face can contain one attachment or one Smartlink, not both.')
    if (item.back?.smartlink !== undefined) readSmartlink(item.back.smartlink)
    if (item.back?.smartlink && item.back.assetId) throw new Error('A card face can contain one attachment or one Smartlink, not both.')
    if (item.imageEdits !== undefined) {
      if (item.kind !== 'image' || !item.assetId) throw new Error('Front image edits require an image source.')
      readImageEdits(item.imageEdits)
    }
    if (item.back?.imageEdits !== undefined) {
      if (!item.back.assetId) throw new Error('Back image edits require an attachment source.')
      readImageEdits(item.back.imageEdits)
    }
  }
}

export function canvasFormatVersion(projects: readonly CanvasProject[]): CanvasFormatVersion {
  if (projects.some(project => project.objects.some(item => item.smartlink !== undefined || item.back?.smartlink !== undefined))) return 5
  if (projects.some(project => project.objects.some(item => item.audioAppearance !== undefined || item.back?.audioAppearance !== undefined))) return 4
  if (projects.some(project => project.swatches !== undefined || project.edges.some(edge => edge.colour !== undefined) ||
    project.objects.some(item => item.imageEdits !== undefined || item.back?.imageEdits !== undefined || item.textColour !== undefined))) return 3
  return containsCardExtensions(projects) ? 2 : 1
}

export function editedImageAssetIds(projects: readonly CanvasProject[]) {
  const ids = new Set<string>()
  for (const project of projects) for (const item of project.objects) {
    if (item.imageEdits && item.assetId) ids.add(item.assetId)
    if (item.back?.imageEdits && item.back.assetId) ids.add(item.back.assetId)
  }
  return ids
}

export function assertEditedImageAsset(asset: (Pick<CanvasAsset, 'mime' | 'name'> & { blob?: Blob; handle?: FileSystemFileHandle }) | undefined) {
  if (!asset) return
  if (!asset.blob && !asset.handle && asset.mime === 'application/octet-stream') return
  if (!/^image\/(?:avif|bmp|gif|jpeg|png|webp)$/.test(asset.mime)) {
    throw new Error(`Image edits require a supported raster image. “${asset.name}” has a different file type.`)
  }
}
