import { zipSync } from 'fflate'
import { GRID_SPACING, rotatedBounds } from './geometry.ts'
import { readableInk } from './colour.ts'
import { cardFace, cardSide, objectAssetIds, objectFlags, type CanvasAsset, type CanvasProject, type CanvasObject, type CanvasSettings, type TextAlignment } from './model.ts'
import { assertStackMembership } from './stackPersistence.ts'
import { layoutStacks } from './stackScene.ts'
import { assertCanvasImageMetadata, assertEditedImageAsset, canvasFormatVersion, editedImageAssetIds, readProjectSwatches, type CanvasFormatVersion } from './imagePersistence.ts'
import { imageEffectInsets, imageFrameSize, readImageEdits, type ImageEdits } from './imageEdits.ts'
import { loadImage, renderEditedImage } from './imageRendering.ts'
import { readLinkedFile } from './linkedFiles.ts'
import { assertProjectAudioAppearance, assertStyledAudioAsset, formatAudioTime, readAudioAppearance, resolvedAudioAppearance, styledAudioAssetIds, type AudioAppearance } from './audioAppearance.ts'
import { audioSourceKey, getCachedAudioPeaks, loadAudioPeaks, measureAudioSource, type AudioPeakResult } from './audioPeaks.ts'

export type CanvasExportFormat = 'croft' | 'zip' | 'svg' | 'png' | 'jpg' | 'pdf'
export type CanvasExportOptions = {
  scope?: 'canvas' | 'selection' | 'project'
  selectedIds?: readonly string[]
  theme?: 'light' | 'dark'
  background?: 'clean' | 'grid' | 'transparent'
}

type AssetEntry = { id: string; name: string; mime: string; size: number; path?: string; sha256?: string; linked?: boolean }
type Manifest = { format: 'croft-icanvas'; version: CanvasFormatVersion; projects: CanvasProject[]; assets: AssetEntry[] }
type JsonObject = Record<string, unknown>

const limit = { package: 120 * 1024 ** 2, manifest: 8 * 1024 ** 2, asset: 40 * 1024 ** 2, projects: 1000, objects: 25000, assets: 2000 }
export const visualExportLimits = { sourceBytes: 16 * 1024 ** 2, imageMarkup: 48 * 1024 ** 2, editedSide: 1600, canvasSide: 4096, canvasPixels: 12_000_000 }
const visualAudioLimits = { newSources: 6, totalWaveforms: 256, decodeWindowMs: 5000, bars: 96 }
const objectKinds = ['text', 'note', 'rectangle', 'ellipse', 'stroke', 'image', 'audio', 'video', 'file', 'canvas', 'frame', 'group', 'page', 'stack'] as const
const assetPath = /^assets\/[0-9]{5}\.bin$/
const activeFileName = /\.(?:app|bat|cmd|com|cpl|dll|exe|hta|html?|jar|js|jse|lnk|msi|msp|pif|ps1|reg|scf|scr|svgz?|url|vb[es]?|ws[fh]|xhtml|xml)(?:\s|\.)*$/i
const mediaTypes = new Set(['audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-wav', 'video/mp4', 'video/ogg', 'video/quicktime', 'video/webm'])
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function object(value: unknown): JsonObject {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.')
  return value as JsonObject
}

function list(value: unknown, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, 'Invalid or oversized item list.')
  return value
}

function string(value: unknown, max = 512): string {
  requireValue(typeof value === 'string' && value.length <= max, 'Invalid or oversized text field.')
  return value
}

function id(value: unknown): string {
  const key = string(value, 128)
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(key), 'Invalid identifier.')
  return key
}

function number(value: unknown, min: number, max: number): number {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'Number outside the supported range.')
  return value
}

function boolean(value: unknown): boolean {
  requireValue(typeof value === 'boolean', 'Invalid boolean field.')
  return value
}

function oneOf<const Choice extends string>(value: unknown, choices: readonly Choice[]): Choice {
  requireValue(typeof value === 'string' && (choices as readonly string[]).includes(value), 'Unknown value in package.')
  return value as Choice
}

function optional<T>(value: unknown, read: (item: unknown) => T): T | undefined {
  return value === undefined ? undefined : read(value)
}

function readPoint(value: unknown, generous = false) {
  const data = object(value)
  const bound = generous ? Number.MAX_VALUE : 1e12
  return { x: number(data.x, -bound, bound), y: number(data.y, -bound, bound) }
}

function readCamera(value: unknown, generous = false) {
  const data = object(value)
  // Translation is in screen pixels. At high zoom it can exceed the world-coordinate bound.
  return { ...readPoint(data, true), zoom: number(data.zoom, generous ? Number.MIN_VALUE : 0.000001, generous ? Number.MAX_VALUE : 1e6) }
}

function readColour(value: unknown) {
  const colour = string(value, 9)
  requireValue(/^#[0-9a-f]{3,4}$|^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(colour), 'Invalid object colour.')
  return colour
}

function readObject(value: unknown, generous: boolean, maxItems: number): CanvasObject {
  const data = object(value)
  const bound = generous ? Number.MAX_VALUE : 1e9
  const back = optional(data.back, value => {
    const face = object(value)
    const imageEdits = optional(face.imageEdits, readImageEdits)
    const audioAppearance = optional(face.audioAppearance, readAudioAppearance)
    return { title: string(face.title, generous ? Infinity : 512), text: string(face.text, generous ? Infinity : 200_000), assetId: optional(face.assetId, id),
      ...(imageEdits && { imageEdits }), ...(audioAppearance && { audioAppearance }) }
  })
  const imageEdits = optional(data.imageEdits, readImageEdits)
  const audioAppearance = optional(data.audioAppearance, readAudioAppearance)
  const textColour = optional(data.textColour, readColour)
  const visibleSide = optional(data.visibleSide, side => oneOf(side, ['front', 'back']))
  const textAlign = optional(data.textAlign, alignment => oneOf(alignment, ['left', 'center', 'right']))
  const stack = optional(data.stack, value => {
    const shape = object(value)
    return { order: list(shape.order, maxItems).map(id), layout: oneOf(shape.layout, ['compact', 'fan']) }
  })
  return {
    id: id(data.id), ...readPoint(data, generous), kind: oneOf(data.kind, objectKinds),
    width: number(data.width, generous ? Number.MIN_VALUE : 0.000001, bound), height: number(data.height, generous ? Number.MIN_VALUE : 0.000001, bound),
    rotation: number(data.rotation, -bound, bound), opacity: number(data.opacity, 0, 1),
    hidden: boolean(data.hidden), locked: boolean(data.locked), name: string(data.name, generous ? Infinity : 512), text: string(data.text, generous ? Infinity : 200_000),
    colour: readColour(data.colour), mode: oneOf(data.mode, ['direct', 'card']),
    parentId: optional(data.parentId, id), assetId: optional(data.assetId, id), targetId: optional(data.targetId, id),
    points: optional(data.points, (points) => list(points, generous ? maxItems : 50_000).map(point => readPoint(point, generous))),
    strokeWidth: optional(data.strokeWidth, (width) => number(width, 0.000001, 1000)),
    collapsed: optional(data.collapsed, boolean), caption: optional(data.caption, (caption) => string(caption, generous ? Infinity : 16_384)),
    border: optional(data.border, boolean), referenceOnly: optional(data.referenceOnly, boolean),
    ...(back && { back }),
    ...(imageEdits && { imageEdits }),
    ...(audioAppearance && { audioAppearance }),
    ...(textColour && { textColour }),
    ...(visibleSide && { visibleSide }),
    ...(textAlign && { textAlign }),
    ...(stack && { stack }),
    frameBase: optional(data.frameBase, (value) => {
      requireValue(data.kind === 'frame', 'Only frames can have a sizing baseline.')
      const base = object(value)
      return { ...readPoint(base, generous), width: number(base.width, generous ? Number.MIN_VALUE : 0.000001, bound),
        height: number(base.height, generous ? Number.MIN_VALUE : 0.000001, bound), rotation: number(base.rotation, -bound, bound) }
    }),
  }
}

function readSettings(value: unknown): CanvasSettings {
  const data = object(value)
  const visibility = object(data.showEdges)
  return {
    grid: oneOf(data.grid, ['dots', 'lines', 'none']), minimap: boolean(data.minimap), snapGrid: boolean(data.snapGrid),
    snapObjects: boolean(data.snapObjects), guides: boolean(data.guides),
    showEdges: { direction: boolean(visibility.direction), connection: boolean(visibility.connection), relationship: boolean(visibility.relationship) },
    toolbar: oneOf(data.toolbar, ['floating', 'parked']), toolbarPoint: readPoint(data.toolbarPoint),
    panel: oneOf(data.panel, ['properties', 'layers', 'closed']),
    ...(data.inspectorSide !== undefined && { inspectorSide: oneOf(data.inspectorSide, ['left', 'right']) }),
  }
}

export function readProject(value: unknown, workspaceMaxItems?: number): CanvasProject {
  const data = object(value)
  const workspace = workspaceMaxItems !== undefined
  const maxItems = workspaceMaxItems ?? limit.objects
  const swatches = optional(data.swatches, readProjectSwatches)
  const project: CanvasProject = {
    id: id(data.id), parentId: data.parentId === null ? null : id(data.parentId),
    name: string(data.name), description: string(data.description, 16_384), icon: string(data.icon, 32),
    coverAssetId: optional(data.coverAssetId, id), iconAssetId: optional(data.iconAssetId, id),
    trashedAt: optional(data.trashedAt, (value) => number(value, 0, 8.64e15)), createdAt: number(data.createdAt, 0, 8.64e15),
    updatedAt: number(data.updatedAt, 0, 8.64e15), camera: readCamera(data.camera, workspace), settings: readSettings(data.settings),
    ...(swatches && { swatches }),
    objects: list(data.objects, maxItems).map(item => readObject(item, workspace, maxItems)),
    edges: list(data.edges, maxItems).map((value) => {
      const edge = object(value)
      const colour = optional(edge.colour, readColour)
      return { id: id(edge.id), kind: oneOf(edge.kind, ['direction', 'connection', 'relationship']), from: id(edge.from), to: id(edge.to),
        label: string(edge.label, workspace ? Infinity : 4096), ...(colour && { colour }) }
    }),
    stops: list(data.stops, workspace ? maxItems : 10_000).map((value) => {
      const stop = object(value)
      return { id: id(stop.id), name: string(stop.name, workspace ? Infinity : 512), canvasId: id(stop.canvasId), camera: readCamera(stop.camera, workspace), duration: number(stop.duration, 0, 86400000) }
    }),
  }
  assertCanvasImageMetadata(project)
  assertProjectAudioAppearance(project)
  return project
}

function readAsset(value: unknown): AssetEntry {
  const data = object(value)
  const path = optional(data.path, (value) => string(value, 64))
  const sha256 = optional(data.sha256, (value) => string(value, 64))
  const size = number(data.size, 0, path ? limit.asset : Number.MAX_SAFE_INTEGER)
  requireValue(Number.isInteger(size), 'Invalid asset size.')
  requireValue(path === undefined ? sha256 === undefined : assetPath.test(path) && sha256 && /^[a-f0-9]{64}$/.test(sha256), 'Invalid asset path or checksum.')
  const mime = string(data.mime, 127).toLowerCase()
  requireValue(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime), 'Invalid media type.')
  const name = string(data.name)
  requireValue(name && !/[\\/\u0000-\u001f]/.test(name) && !activeFileName.test(name), 'Unsafe attachment file name.')
  const linked = optional(data.linked, boolean)
  requireValue(!linked || path === undefined, 'Linked attachments cannot contain embedded bytes.')
  return { id: id(data.id), name, mime, size, path, sha256, linked }
}

function registry<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map(items.map((entry) => [entry.id, entry]))
  requireValue(map.size === items.length, 'Duplicate identifier in package.')
  return map
}

function checkHierarchy(rows: Map<string, { id: string; parentId?: string | null }>) {
  const checked = new Set<string>()
  for (const row of rows.values()) {
    const visit = new Set<string>()
    let current: typeof row | undefined = row
    while (current && !checked.has(current.id)) {
      requireValue(!visit.has(current.id), 'Cycle in package hierarchy.')
      visit.add(current.id)
      if (!current.parentId) break
      current = rows.get(current.parentId)
      requireValue(current, 'Missing parent in package hierarchy.')
    }
    for (const key of visit) checked.add(key)
  }
}

function readManifest(bytes: Uint8Array): Manifest {
  requireValue(bytes.byteLength <= limit.manifest, 'Package manifest is too large.')
  const data = object(JSON.parse(decoder.decode(bytes)) as unknown)
  requireValue(data.format === 'croft-icanvas' && (data.version === 1 || data.version === 2 || data.version === 3 || data.version === 4), 'Unsupported Croft package format or version.')
  const projects = list(data.projects, limit.projects).map((entry) => readProject(entry))
  const neededVersion = canvasFormatVersion(projects)
  requireValue(data.version >= neededVersion, `This content requires a version ${neededVersion} Croft package.`)
  const assets = list(data.assets, limit.assets).map(readAsset)
  requireValue(projects.length > 0 && projects.reduce((total, project) => total + project.objects.length, 0) <= limit.objects, 'Package has no canvases or too many objects.')
  const projectMap = registry(projects)
  const assetMap = registry(assets)
  for (const id of editedImageAssetIds(projects)) {
    const asset = assetMap.get(id)
    if (asset?.path && asset.mime === 'application/octet-stream') throw new Error('Edited image source data do not match a supported raster image.')
    assertEditedImageAsset(asset)
  }
  for (const id of styledAudioAssetIds(projects)) {
    const asset = assetMap.get(id)
    requireValue(!asset?.path || asset.mime !== 'application/octet-stream', 'Audio appearance requires an audio source.')
    assertStyledAudioAsset(asset)
  }
  checkHierarchy(projectMap)
  for (const project of projects) {
    const objectMap = registry(project.objects)
    checkHierarchy(objectMap)
    assertStackMembership(project.objects)
    registry(project.edges)
    registry(project.stops)
    requireValue(!project.coverAssetId || assetMap.has(project.coverAssetId), 'Package references a missing cover asset.')
    requireValue(!project.iconAssetId || assetMap.has(project.iconAssetId), 'Package references a missing icon asset.')
    for (const item of project.objects) {
      requireValue(objectAssetIds(item).every(id => assetMap.has(id)), 'Package references a missing asset.')
      requireValue(item.kind !== 'canvas' || !item.targetId || projectMap.has(item.targetId), 'Package references a missing canvas.')
      requireValue(!item.parentId || ['frame', 'group', 'stack'].includes(objectMap.get(item.parentId)!.kind), 'Invalid parent object.')
    }
    for (const edge of project.edges) requireValue(objectMap.has(edge.from) && objectMap.has(edge.to), 'Edge refers to a missing object.')
    for (const stop of project.stops) requireValue(projectMap.has(stop.canvasId), 'Presentation stop refers to a missing canvas.')
  }
  const paths = assets.flatMap((asset) => asset.path ? [asset.path] : [])
  requireValue(new Set(paths).size === paths.length, 'Duplicate asset entry in package.')
  return { format: 'croft-icanvas', version: data.version, projects, assets }
}

// Croft packages store entries. The reader has no decompression path and never
// writes paths to the OS. Checking both headers prevents ambiguous ZIP views.
function openPackage(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const get32 = (offset: number) => view.getUint32(offset, true)
  const get16 = (offset: number) => view.getUint16(offset, true)
  const end = view.byteLength - 22
  requireValue(end >= 0 && get32(end) === 0x06054b50 && get32(end + 4) === 0 && get16(end + 20) === 0, 'Unsupported ZIP directory.')
  const count = get16(end + 10)
  const central = get32(end + 16)
  requireValue(count > 0 && count <= limit.assets + 1 && get16(end + 8) === count && central + get32(end + 12) === end, 'Invalid ZIP directory size.')
  const entries = new Map<string, Uint8Array>()
  const regions: { first: number; last: number }[] = []
  let offset = central
  for (let index = 0; index < count; index++) {
    requireValue(offset + 46 <= end && get32(offset) === 0x02014b50, 'Invalid ZIP entry.')
    const size = get32(offset + 24)
    const length = get16(offset + 28)
    const local = get32(offset + 42)
    const extra = get16(offset + 30)
    const comment = get16(offset + 32)
    const flags = get16(offset + 8)
    requireValue((flags === 0 || flags === 0x0800) && get16(offset + 10) === 0 && size === get32(offset + 20) && get16(offset + 34) === 0, 'Package must contain plain, stored ZIP entries.')
    requireValue(extra === 0 && comment === 0 && offset + 46 + length <= end, 'Invalid ZIP entry name or extra data.')
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + length))
    requireValue(name === 'manifest.json' || assetPath.test(name), 'Unexpected path in Croft package.')
    requireValue(!entries.has(name) && size <= (name === 'manifest.json' ? limit.manifest : limit.asset), 'Duplicate or oversized ZIP entry.')
    const content = local + 30 + length
    requireValue(content + size <= central && get32(local) === 0x04034b50 && get16(local + 6) === flags && get16(local + 8) === 0, 'Invalid ZIP entry location.')
    requireValue(get32(local + 14) === get32(offset + 16) && get32(local + 18) === size && get32(local + 22) === size && get16(local + 26) === length && get16(local + 28) === 0, 'ZIP headers disagree.')
    requireValue(decoder.decode(bytes.subarray(local + 30, content)) === name, 'ZIP entry names disagree.')
    entries.set(name, bytes.subarray(content, content + size))
    regions.push({ first: local, last: content + size })
    offset += 46 + length
  }
  requireValue(offset === end, 'Trailing data in ZIP directory.')
  let expected = 0
  for (const { first, last } of regions.sort((a, b) => a.first - b.first)) {
    requireValue(first === expected, 'Overlapping or unmatched ZIP entries.')
    expected = last
  }
  requireValue(expected === central, 'Unmatched bytes near ZIP directory.')
  return entries
}

function cloneBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

async function hash(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', cloneBytes(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function rasterMime(bytes: Uint8Array) {
  const begins = (test: number[]) => test.every((entry, index) => entry === bytes[index])
  const has = (offset: number, text: string) => Array.from(text).every((entry, index) => entry.charCodeAt(0) === bytes[offset + index])
  if (begins([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png'
  if (begins([255, 216, 255])) return 'image/jpeg'
  if (has(0, 'GIF87a') || has(0, 'GIF89a')) return 'image/gif'
  if (has(0, 'RIFF') && has(8, 'WEBP')) return 'image/webp'
  if (has(0, 'BM')) return 'image/bmp'
  if (has(4, 'ftyp') && (has(8, 'avif') || has(8, 'avis'))) return 'image/avif'
  return undefined
}

export function safeMime(declared: string, bytes: Uint8Array) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^\uFEFF/, '').trimStart()
  requireValue(!/^(?:<\?xml\b|<!doctype\s+html\b|<html\b|<head\b|<body\b|<svg\b|<script\b|#!)/i.test(prefix) && !(bytes[0] === 77 && bytes[1] === 90), 'Package attachment contains active content.')
  if (declared.startsWith('image/')) return rasterMime(bytes) === declared ? declared : 'application/octet-stream'
  if (declared === 'application/pdf') return prefix.startsWith('%PDF-') ? declared : 'application/octet-stream'
  if (mediaTypes.has(declared) || declared === 'text/plain' || declared === 'text/csv') return declared
  return 'application/octet-stream'
}

export async function importProject(file: Blob): Promise<{ projects: CanvasProject[]; assets: CanvasAsset[] }> {
  requireValue(file.size > 0 && file.size <= limit.package, 'Croft package is empty or exceeds 120 MiB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isZip = bytes[0] === 80 && bytes[1] === 75
  const files = isZip ? openPackage(bytes) : new Map([['manifest.json', bytes]])
  const raw = files.get('manifest.json')
  requireValue(raw, 'Croft manifest is missing.')
  const manifest = readManifest(raw)
  const expectedFiles = 1 + manifest.assets.filter((asset) => asset.path).length
  requireValue(files.size === expectedFiles, 'Archive entries do not match the manifest.')
  const assetIds = new Map<string, string>()
  const assets: CanvasAsset[] = []
  const editedIds = editedImageAssetIds(manifest.projects)
  const audioIds = styledAudioAssetIds(manifest.projects)
  for (const entry of manifest.assets) {
    const assetId = crypto.randomUUID()
    assetIds.set(entry.id, assetId)
    const { name, mime, size } = entry
    if (!entry.path) {
      assets.push({ id: assetId, name, mime, size, ...(entry.linked ? { linked: true as const } : {}) })
      continue
    }
    const fileBytes = files.get(entry.path)
    requireValue(fileBytes && fileBytes.byteLength === size && await hash(fileBytes) === entry.sha256, 'Asset is missing or failed its checksum.')
    const type = safeMime(mime, fileBytes)
    const asset = { id: assetId, name, mime: type, size, blob: new Blob([cloneBytes(fileBytes)], { type }) }
    if (editedIds.has(entry.id)) assertEditedImageAsset(asset)
    if (audioIds.has(entry.id)) assertStyledAudioAsset(asset)
    assets.push(asset)
  }
  const projectIds = new Map(manifest.projects.map((project) => [project.id, crypto.randomUUID()]))
  const projects = manifest.projects.map((project): CanvasProject => {
    const objectIds = new Map(project.objects.map((item) => [item.id, crypto.randomUUID()]))
    return {
      ...project, id: projectIds.get(project.id)!, parentId: project.parentId ? projectIds.get(project.parentId)! : null,
      coverAssetId: project.coverAssetId ? assetIds.get(project.coverAssetId) : undefined,
      iconAssetId: project.iconAssetId ? assetIds.get(project.iconAssetId) : undefined,
      objects: project.objects.map((item) => ({
        ...item, id: objectIds.get(item.id)!, parentId: item.parentId ? objectIds.get(item.parentId) : undefined,
        targetId: item.kind === 'canvas' && item.targetId ? projectIds.get(item.targetId) : item.targetId,
        assetId: item.assetId ? assetIds.get(item.assetId) : undefined,
        ...(item.back ? { back: { ...item.back, assetId: item.back.assetId ? assetIds.get(item.back.assetId) : undefined } } : {}),
        ...(item.stack ? { stack: { ...item.stack, order: item.stack.order.map(id => objectIds.get(id)!) } } : {}),
      })),
      edges: project.edges.map((edge) => ({ ...edge, id: crypto.randomUUID(), from: objectIds.get(edge.from)!, to: objectIds.get(edge.to)! })),
      stops: project.stops.map((stop) => ({ ...stop, id: crypto.randomUUID(), canvasId: projectIds.get(stop.canvasId)! })),
    }
  })
  return { projects, assets }
}

function selection<T extends { id: string; parentId?: string | null }>(items: readonly T[], rootIds: readonly string[]) {
  const children = new Map<string, T[]>()
  const selected = new Set(rootIds)
  for (const item of items) {
    if (!item.parentId) continue
    const siblings = children.get(item.parentId) ?? []
    siblings.push(item)
    children.set(item.parentId, siblings)
  }
  for (const key of selected) for (const child of children.get(key) ?? []) selected.add(child.id)
  return items.filter((item) => selected.has(item.id))
}

function scopeProjects(projects: readonly CanvasProject[], root: CanvasProject, options: CanvasExportOptions) {
  if (options.scope === 'project') return selection(projects, [root.id])
  if (options.scope !== 'selection') return [root]
  const objects = selection(root.objects, options.selectedIds ?? [])
  requireValue(objects.length, 'Select objects before exporting this scope.')
  const ids = new Set(objects.map((item) => item.id))
  return [{ ...root, objects: objects.map((item) => ({ ...item, parentId: item.parentId && ids.has(item.parentId) ? item.parentId : undefined })), edges: root.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), stops: [] }]
}

export function projectExportInventory(projects: readonly CanvasProject[], root: CanvasProject, options: CanvasExportOptions, assets: readonly CanvasAsset[]) {
  const scoped = scopeProjects(projects, root, options)
  const scopedIds = new Set(scoped.map(project => project.id))
  const ids = canvasAssetIds(scoped)
  const assetsById = new Map(assets.map(asset => [asset.id, asset]))
  const included = [...ids].flatMap(id => assetsById.get(id)?.blob ? [assetsById.get(id)!] : [])
  const relink = [...ids].flatMap(id => {
    const asset = assetsById.get(id)
    return asset && !asset.blob && (asset.handle || asset.linked) ? [asset] : []
  })
  const missing = [...ids].filter(id => {
    const asset = assetsById.get(id)
    return !asset?.blob && !asset?.handle && !asset?.linked
  })
  const bytes = included.reduce((total, asset) => total + asset.size, 0)
  const overLimit = included.filter(asset => asset.size > limit.asset)
  const outside = scoped.flatMap(canvas => canvas.objects.filter(item => item.kind === 'canvas' && item.targetId && !scopedIds.has(item.targetId)))
  const externalPages = scoped.flatMap(canvas => canvas.objects.filter(item => item.kind === 'page' && item.targetId))
  return { projectCount: scoped.length, ids, included, relink, missing, bytes, overLimit, outside, externalPages,
    exceedsPackage: bytes > limit.package - limit.manifest, maxAssetMiB: limit.asset / 1024 ** 2, maxPackageMiB: limit.package / 1024 ** 2 }
}

export function canvasAssetIds(projects: readonly CanvasProject[]) {
  const ids = new Set<string>()
  for (const project of projects) {
    if (project.coverAssetId) ids.add(project.coverAssetId)
    if (project.iconAssetId) ids.add(project.iconAssetId)
    for (const item of project.objects) for (const assetId of objectAssetIds(item)) ids.add(assetId)
  }
  return ids
}

export async function makeProjectPackage(projects: readonly CanvasProject[], projectId: string, options: CanvasExportOptions = {}, assets: readonly CanvasAsset[] = []) {
  const root = projects.find((entry) => entry.id === projectId)
  requireValue(root, 'Canvas is missing.')
  const scoped = scopeProjects(projects, root, options)
  const projectsById = new Set(scoped.map((project) => project.id))
  const assetIds = canvasAssetIds(scoped)
  const portableProjects = scoped.map((project) => {
    return {
      ...project, parentId: project.id === root.id ? null : project.parentId,
      objects: project.objects.map((item) => {
        return { ...item, targetId: item.kind === 'canvas' && item.targetId && !projectsById.has(item.targetId) ? undefined : item.targetId }
      }),
      stops: project.stops.filter((stop) => projectsById.has(stop.canvasId)),
    }
  })
  requireValue(assetIds.size <= limit.assets, 'Too many attached assets to export.')
  const files: Record<string, Uint8Array> = {}
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
  const manifestAssets: AssetEntry[] = []
  let total = 0
  for (const assetId of assetIds) {
    const asset = assetsById.get(assetId)
    const manifestAsset = { id: assetId, name: asset?.name ?? 'Missing attachment', mime: asset?.mime || 'application/octet-stream', size: asset?.size ?? 0 }
    if (asset?.blob) {
      const { size } = asset.blob
      total += size
      requireValue(size <= limit.asset && total <= limit.package - limit.manifest, 'Attached media exceed the editable package limit.')
      const bytes = new Uint8Array(await asset.blob.arrayBuffer())
      const path = `assets/${String(manifestAssets.length).padStart(5, '0')}.bin`
      files[path] = bytes
      manifestAssets.push({ ...manifestAsset, mime: safeMime(manifestAsset.mime, bytes), size, path, sha256: await hash(bytes) })
    } else manifestAssets.push({ ...manifestAsset, linked: Boolean(asset?.handle || asset?.linked) || undefined })
  }
  const manifest: Manifest = { format: 'croft-icanvas', version: canvasFormatVersion(portableProjects), projects: portableProjects, assets: manifestAssets }
  const raw = encoder.encode(JSON.stringify(manifest, null, 2))
  readManifest(raw)
  files['manifest.json'] = raw
  const archive = zipSync(files, { level: 0, mtime: new Date(2000, 0, 1) })
  requireValue(archive.length <= limit.package, 'Croft package exceeds 120 MiB.')
  return new Blob([cloneBytes(archive)], { type: 'application/zip' })
}

function xml(value: string) {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '').replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!)
}

function lines(text: string, width: number, fontSize: number, rows: number) {
  const limit = Math.max(1, Math.floor(width / (fontSize * 0.6)))
  const result: string[] = []
  for (const line of text.split('\n')) {
    const content = Array.from(line)
    for (let start = 0; start < content.length || start === 0;) {
      if (result.length >= rows) return result
      let end = start + limit
      if (end < content.length && !/\s/.test(content[end])) {
        let wordBreak = end - 1
        while (wordBreak > start && !/\s/.test(content[wordBreak])) wordBreak--
        if (wordBreak > start) end = wordBreak
      }
      result.push(content.slice(start, end).join('').trimEnd())
      while (end < content.length && /\s/.test(content[end])) end++
      start = end
    }
  }
  return result
}

function textPlacement(width: number, padding: number, align?: TextAlignment) {
  if (align === 'center') return { x: width / 2, anchor: 'middle' }
  if (align === 'right') return { x: width - padding, anchor: 'end' }
  return { x: padding, anchor: 'start' }
}

function textSvg(text: string, width: number, height: number, ink: string, font = 15, padding = 12, y = 20, align?: TextAlignment) {
  const { x, anchor } = textPlacement(width, padding, align)
  const lineHeight = font * 1.25
  const body = lines(text, Math.max(1, width - padding * 2), font, Math.max(1, Math.floor((height - y) / lineHeight) + 1))
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${ink}" font-size="${font}" font-family="Segoe UI, sans-serif">${body.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${xml(line)}</tspan>`).join('')}</text>`
}

function backTextSvg(title: string, body: string, width: number, height: number, ink: string, align?: TextAlignment) {
  const padding = 12
  const { x, anchor } = textPlacement(width, padding, align)
  const size = 15
  const titleRows = title ? lines(title, width - padding * 2, size, Math.max(0, Math.floor((height - 34) / 18) + 1)) : []
  const start = titleRows.length ? 34 + titleRows.length * 18 : 34
  const heading = titleRows.length ? `<text x="${x}" y="34" text-anchor="${anchor}" fill="${ink}" font-size="${size}" font-weight="650" font-family="Segoe UI, sans-serif">${titleRows.map((line, i) => `<tspan x="${x}" dy="${i ? 18 : 0}">${xml(line)}</tspan>`).join('')}</text>` : ''
  return `<svg width="${width}" height="${height}"><text x="${padding}" y="16" fill="${ink}" font-size="10" font-family="Segoe UI, sans-serif">Back</text>${heading}${body && start < height ? textSvg(body, width, height, ink, 13, padding, start, align) : ''}</svg>`
}

async function embedImage(asset: CanvasAsset | undefined) {
  if (!asset?.blob || asset.blob.size > visualExportLimits.sourceBytes) return null
  const bytes = new Uint8Array(await asset.blob.arrayBuffer())
  const mime = rasterMime(bytes)
  if (!mime) return null
  const chunks: string[] = []
  for (let start = 0; start < bytes.length; start += 16_384) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 16_384)))
  return `data:${mime};base64,${btoa(chunks.join(''))}`
}

type StaticAudioData = { duration?: number; waveform?: Extract<AudioPeakResult, { status: 'ready' }> }
type StaticAudioBudget = ReturnType<typeof newStaticAudioBudget>

function newStaticAudioBudget() {
  return { newSources: visualAudioLimits.newSources, remaining: visualAudioLimits.totalWaveforms,
    until: performance.now() + visualAudioLimits.decodeWindowMs, inspected: new Map<string, StaticAudioData>() }
}

async function staticAudioData(asset: CanvasAsset | undefined, budget: StaticAudioBudget): Promise<StaticAudioData> {
  if (!asset || typeof document === 'undefined' || budget.remaining <= 0) return {}
  const previous = budget.inspected.get(asset.id)
  if (previous) return previous
  const known = asset.blob && asset.blob.size === asset.size && getCachedAudioPeaks(audioSourceKey(asset))
  if (known) return { duration: known.duration, waveform: known }
  const timeLeft = Math.ceil(budget.until - performance.now())
  if (timeLeft <= 0 || budget.newSources <= 0 || !asset.blob && !asset.handle) return {}
  budget.newSources--
  const signal = AbortSignal.timeout(timeLeft)
  try {
    let source = asset.blob
    let linked: File | undefined
    if (!source && asset.handle) {
      const result = await readLinkedFile({ ...asset, handle: asset.handle }, async file =>
        safeMime(file.type, new Uint8Array(await file.slice(0, 2048).arrayBuffer())))
      if ('file' in result) source = linked = result.file
    }
    if (!source || source.size !== asset.size || signal.aborted) throw new Error('Audio unavailable for visual export.')
    const key = audioSourceKey(asset, linked)
    const cached = getCachedAudioPeaks(key)
    const duration = cached?.duration ?? await measureAudioSource(source, signal)
    const result = cached ?? await loadAudioPeaks({ blob: source, key }, duration, signal)
    const found = { duration, waveform: result.status === 'ready' ? result : undefined }
    budget.inspected.set(asset.id, found)
    return found
  } catch {
    budget.inspected.set(asset.id, {})
    return {}
  }
}

function staticAudioSvg(title: string, width: number, height: number, ink: string, dark: boolean,
  appearance: AudioAppearance | undefined, data: StaticAudioData, offset = 0) {
  const { waveform, duration } = data
  const heading = textSvg(title, width, 23, ink, 13, 10, 17)
  const timing = duration === undefined ? '' : ` · ${formatAudioTime(duration)}`
  if (!waveform || height < 56 || width < 32) {
    return `<svg y="${offset}" width="${width}" height="${height}" data-audio-waveform="unavailable" aria-label="Waveform unavailable">${heading}${textSvg(`Audio${timing} · Waveform unavailable`, width, height, ink, 11, 10, 36)}</svg>`
  }
  const style = resolvedAudioAppearance(appearance, dark)
  const count = Math.min(waveform.peaks.length, visualAudioLimits.bars, Math.max(1, Math.floor((width - 20) / 3)))
  const step = (width - 22) / count
  const barTop = 25
  const barBottom = height - 20
  const barMiddle = (barTop + barBottom) / 2
  let path = ''
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * waveform.peaks.length / count)
    const end = Math.floor((i + 1) * waveform.peaks.length / count)
    let peak = 0
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(waveform.peaks[j]))
    if (peak <= 0) continue
    const x = (12 + (i + .5) * step).toFixed(2)
    const amplitude = peak * (barBottom - barTop) / 2
    path += `M${x} ${(barMiddle - amplitude).toFixed(2)}V${(barMiddle + amplitude).toFixed(2)}`
  }
  return `<svg y="${offset}" width="${width}" height="${height}" data-audio-waveform="unplayed" data-audio-duration="${waveform.duration}">${heading}<path d="${path}" fill="none" stroke="${style.waveColour}" stroke-width="${Math.max(.65, Math.min(2, step * .62))}" stroke-linecap="round"/><path d="M11 ${barTop}V${barBottom}" stroke="${style.playheadColour}" stroke-width="1.3"/>${textSvg(formatAudioTime(waveform.duration), width, height, ink, 11, 10, height - 6, 'right')}</svg>`
}

function visibleScene(project: CanvasProject) {
  const byId = new Map(project.objects.map(item => [item.id, item]))
  const stacks = layoutStacks(project.objects)
  const eligible = project.objects.filter(item => !objectFlags(item, byId).hidden)
  const shown = new Set(eligible.map(item => item.id))
  const visible = eligible.filter(item => item.kind !== 'stack' && !stacks.obscured.has(item.id)).map(item => stacks.cards.get(item.id) ?? item)
  return { byId, stacks, shown, visible }
}

function visibleImageEdit(item: CanvasObject) {
  return cardSide(item) === 'back' ? item.back?.imageEdits : item.imageEdits
}

export function editedVisualImageInventory(projects: readonly CanvasProject[], root: CanvasProject, options: CanvasExportOptions, assets: readonly CanvasAsset[]) {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  return scopeProjects(projects, root, options).flatMap(project => visibleScene(project).visible.flatMap(item => {
    const edits = visibleImageEdit(item)
    const id = cardSide(item) === 'back' ? item.back?.assetId : item.assetId
    if (!edits) return []
    const asset = id ? byId.get(id) : undefined
    return [{ id, label: asset?.name ?? item.name, linked: !!asset?.handle, unavailable: !asset?.blob && !asset?.handle,
      tooLarge: (asset?.blob?.size ?? asset?.size ?? 0) > visualExportLimits.sourceBytes }]
  }))
}

function editedImageBounds(item: CanvasObject, edits: ImageEdits) {
  const frame = imageFrameSize(item, cardSide(item))
  const insets = imageEffectInsets(edits)
  const width = frame.width + insets.left + insets.right
  const height = frame.height + insets.top + insets.bottom
  const x = frame.x - insets.left + width / 2 - item.width / 2
  const y = frame.y - insets.top + height / 2 - item.height / 2
  const theta = item.rotation % 360 * Math.PI / 180
  const centerX = item.x + item.width / 2 + Math.cos(theta) * x - Math.sin(theta) * y
  const centerY = item.y + item.height / 2 + Math.sin(theta) * x + Math.cos(theta) * y
  return rotatedBounds({ x: centerX - width / 2, y: centerY - height / 2, width, height }, item.rotation)
}

async function editedImageMarkup(asset: CanvasAsset | undefined, item: CanvasObject, edits: ImageEdits) {
  const label = asset?.name || item.name
  requireValue(asset, `The source for edited image “${label}” is missing. Relink it before visual export.`)
  requireValue(asset.size <= visualExportLimits.sourceBytes, `Edited image “${label}” exceeds the 16 MiB visual source limit. Use an editable package or workspace backup to retain the original.`)
  let source = asset.blob
  if (!source && asset.handle) {
    const checked = await readLinkedFile({ ...asset, handle: asset.handle }, async file =>
      safeMime(asset.mime, new Uint8Array(await file.slice(0, 2048).arrayBuffer())))
    if ('file' in checked) source = checked.file
  }
  requireValue(source, `The source for edited image “${label}” is unavailable. Restore file access or relink it before visual export.`)
  requireValue(source.size === asset.size, `The source for edited image “${label}” no longer matches its recorded size.`)
  const mime = rasterMime(new Uint8Array(await source.slice(0, 32).arrayBuffer()))
  requireValue(mime && mime === asset.mime, `The source for edited image “${label}” is not a supported raster image.`)
  const url = URL.createObjectURL(source.slice(0, source.size, mime))
  try {
    const sourceImage = await loadImage(url)
    const frame = imageFrameSize(item, cardSide(item))
    const { canvas, insets, width, height } = renderEditedImage(sourceImage, edits, { ...frame, maxSide: visualExportLimits.editedSide })
    const uri = canvas.toDataURL('image/png')
    requireValue(uri.startsWith('data:image/png;base64,'), `Could not encode edited image “${label}”.`)
    return { uri, markup: `<image href="${uri}" x="${frame.x - insets.left}" y="${frame.y - insets.top}" width="${width}" height="${height}" preserveAspectRatio="none"/>` }
  } catch (error) {
    throw new Error(`Could not export edited image “${label}”. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  } finally { URL.revokeObjectURL(url) }
}

export async function renderProjectSvg(project: CanvasProject, options: CanvasExportOptions = {}, assets: readonly CanvasAsset[] = [], audioBudget = newStaticAudioBudget()) {
  const { byId, stacks, shown, visible } = visibleScene(project)
  const rear = [...stacks.piles.values()].filter(pile => shown.has(pile.stack.id)).flatMap(pile => [...pile.rear].reverse())
  const boxes = [...visible.flatMap(item => {
    const edits = visibleImageEdit(item)
    const objectBounds = rotatedBounds(item, item.rotation)
    return edits ? [objectBounds, editedImageBounds(item, edits)] : [objectBounds]
  }), ...rear.map(card => rotatedBounds(card.rect, card.rect.rotation))]
  const extent = boxes.reduce((bounds, item) => ({ left: Math.min(bounds.left, item.left), top: Math.min(bounds.top, item.top), right: Math.max(bounds.right, item.right), bottom: Math.max(bounds.bottom, item.bottom) }), boxes[0] ?? { left: 0, top: 0, right: 720, bottom: 420 })
  const x = Math.floor(extent.left) - 32
  const y = Math.floor(extent.top) - 32
  const worldWidth = Math.ceil(extent.right) - x + 32
  const worldHeight = Math.ceil(extent.bottom) - y + 32
  const scale = Math.min(1, visualExportLimits.canvasSide / worldWidth, visualExportLimits.canvasSide / worldHeight,
    Math.sqrt(visualExportLimits.canvasPixels / (worldWidth * worldHeight)))
  const width = Math.ceil(worldWidth * scale)
  const height = Math.ceil(worldHeight * scale)
  const dark = options.theme === 'dark'
  const ink = dark ? '#e9efed' : '#27322c'
  const backdrop = dark ? '#242a27' : '#fcfcf9'
  const dot = dark ? '#4e5851' : '#cbd5cd'
  const surface = dark ? '#323a35' : '#ffffff'
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]))
  const audioMarkup = async (title: string, item: CanvasObject, asset: CanvasAsset | undefined, appearance: AudioAppearance | undefined, offset = 0) => {
    const data = await staticAudioData(asset, audioBudget)
    if (data.waveform) audioBudget.remaining--
    return staticAudioSvg(title, item.width, item.height - offset, item.mode === 'card' ? readableInk(item.colour) ?? ink : ink, dark, appearance, data, offset)
  }
  const edgeLines = project.edges.filter((edge) => shown.has(edge.from) && shown.has(edge.to) && project.settings.showEdges[edge.kind]).map((edge) => {
    const first = (stacks.proxies.get(edge.from) ?? byId.get(edge.from))!
    const last = (stacks.proxies.get(edge.to) ?? byId.get(edge.to))!
    const x1 = first.x + first.width / 2
    const y1 = first.y + first.height / 2
    const x2 = last.x + last.width / 2
    const y2 = last.y + last.height / 2
    const stroke = edge.colour ? readColour(edge.colour) : edge.kind === 'relationship' ? '#8c6bac' : edge.kind === 'direction' ? '#527e67' : '#778eaf'
    const dash = edge.kind === 'relationship' ? ' stroke-dasharray="5 4"' : ''
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const distance = last.width && last.height
      ? Math.min(Math.abs(last.width / (2 * Math.cos(angle))), Math.abs(last.height / (2 * Math.sin(angle))))
      : 0
    const endX = x2 - Math.cos(angle) * distance
    const endY = y2 - Math.sin(angle) * distance
    const arrow = edge.kind === 'direction' ? ' marker-end="url(#arrow)"' : ''
    return `<path d="M${x1} ${y1} L${endX} ${endY}" fill="none" stroke="${stroke}" stroke-width="2"${dash}${arrow}/>${edge.label ? `<text x="${(x1 + endX) / 2}" y="${(y1 + endY) / 2 - 5}" fill="${ink}" font-size="12" font-family="Segoe UI, sans-serif">${xml(edge.label)}</text>` : ''}`
  })
  const fragments = new Map<string, string>()
  let mediaChars = 0
  const mediaUri = async (assetId?: string) => {
    const media = mediaChars < visualExportLimits.imageMarkup ? await embedImage(assetId ? assetMap.get(assetId) : undefined) : null
    if (media && mediaChars + media.length > visualExportLimits.imageMarkup) return null
    mediaChars += media?.length ?? 0
    return media
  }
  const editedMedia = async (assetId: string | undefined, item: CanvasObject, edits: ImageEdits) => {
    const message = 'Edited images exceed the visual image budget. Export a smaller selection or use an editable package.'
    requireValue(mediaChars < visualExportLimits.imageMarkup, message)
    const { uri, markup } = await editedImageMarkup(assetId ? assetMap.get(assetId) : undefined, item, edits)
    mediaChars += uri.length
    requireValue(mediaChars <= visualExportLimits.imageMarkup, message)
    return markup
  }
  for (const item of visible) {
    const colour = readColour(item.colour)
    const rect = `width="${item.width}" height="${item.height}"`
    const fill = `<rect ${rect} rx="8" fill="${colour}" stroke="#4d685d" stroke-opacity=".22"/>`
    const cardInk = readableInk(colour) ?? '#26312b'
    let content: string
    if (cardSide(item) === 'back') {
      const side = cardFace(item, 'back')
      const asset = side.assetId ? assetMap.get(side.assetId) : undefined
      if (side.audioAppearance || asset?.mime.startsWith('audio/')) {
        const offset = Math.min(item.height * .45, side.title || side.text ? 54 : 20)
        content = fill + backTextSvg(side.title, side.text, item.width, offset, cardInk, item.textAlign) +
          await audioMarkup(asset?.name ?? 'Audio attachment', item, asset, side.audioAppearance, offset)
      } else {
        const edits = item.back?.imageEdits
        const media = edits ? null : await mediaUri(side.assetId)
        const assetLabel = side.assetId ? asset?.name || 'Attachment unavailable in export' : ''
        const textHeight = edits ? imageFrameSize(item, 'back').y : media ? item.height * .45 : item.height
        const body = [side.text, media || edits ? '' : assetLabel].filter(Boolean).join('\n') || (!side.title && !side.assetId ? 'The back is empty.' : '')
        content = fill + backTextSvg(side.title, body, item.width, textHeight, cardInk, item.textAlign) +
          (edits ? await editedMedia(side.assetId, item, edits) : media ? `<image href="${media}" x="8" y="${textHeight}" width="${Math.max(1, item.width - 16)}" height="${Math.max(1, item.height - textHeight - 8)}" preserveAspectRatio="xMidYMid meet"/>` : '')
      }
    } else if (item.kind === 'audio' || (item.kind === 'file' && (item.audioAppearance || item.assetId && assetMap.get(item.assetId)?.mime.startsWith('audio/')))) {
      const asset = item.assetId ? assetMap.get(item.assetId) : undefined
      content = (item.mode === 'card' ? fill : '') + await audioMarkup(item.name, item, asset, item.audioAppearance)
    } else if (item.kind === 'image') {
      const border = item.mode === 'direct' && item.border ? `<rect ${rect} rx="5" fill="none" stroke="${colour}" stroke-width="2"/>` : ''
      if (item.imageEdits) {
        const card = item.mode === 'card'
        const picture = await editedMedia(item.assetId, item, item.imageEdits)
        const title = card ? textSvg(item.name, item.width, 22, cardInk, 13, 8, 18, 'center') : ''
        const caption = card && item.caption ? textSvg(item.caption, item.width, item.height, cardInk, 12, 8, item.height - 6) : ''
        content = `${card ? fill : ''}${picture}${border}${title}${caption}`
      } else {
        const media = await mediaUri(item.assetId)
        content = media ? `${item.mode === 'card' ? fill : ''}<image href="${media}" ${rect} preserveAspectRatio="xMidYMid meet"/>${border}`
          : `${fill}${textSvg(`${item.name}\nImage unavailable in export`, item.width, item.height, cardInk, 13)}`
      }
    } else if (item.kind === 'ellipse') {
      content = `<ellipse cx="${item.width / 2}" cy="${item.height / 2}" rx="${item.width / 2}" ry="${item.height / 2}" fill="${colour}"/>`
    } else if (item.kind === 'stroke') {
      content = `<polyline points="${(item.points ?? []).map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="${item.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`
    } else if (item.kind === 'text') {
      const textInk = item.mode === 'card' ? cardInk : item.textColour ? readColour(item.textColour) : ink
      content = (item.mode === 'card' ? fill : '') + textSvg(item.text || item.name, item.width, item.height, textInk, 22, 7, 22, item.textAlign)
    } else if (item.kind === 'frame' || item.kind === 'group') {
      const frameFill = item.kind === 'frame' ? colour : 'none'
      content = `<rect ${rect} rx="8" fill="${frameFill}" fill-opacity=".38" stroke="${dot}"/>${textSvg(item.name, item.width, item.height, ink, 13)}`
    } else if (item.kind === 'note' || item.kind === 'rectangle') {
      const filled = item.mode === 'card' || item.kind === 'rectangle'
      content = (filled ? fill : '') + (item.kind === 'note' || item.text ? textSvg(item.text || item.name, item.width, item.height, filled ? cardInk : ink, 15, 13, 20, item.textAlign) : '')
    } else if (item.kind !== 'stack') {
      const caption = item.caption || { video: 'Video', file: 'Attachment', canvas: 'SubCanvas', page: 'Croft page' }[item.kind]
      content = `<rect ${rect} rx="8" fill="${surface}" stroke="${dot}"/>${textSvg(`${item.name}\n${caption || ''}`, item.width, item.height, ink, 13)}`
    } else content = ''
    fragments.set(item.id, `<g transform="translate(${item.x} ${item.y}) rotate(${item.rotation} ${item.width / 2} ${item.height / 2})" opacity="${item.opacity}">${content}</g>`)
  }
  const containers = visible.filter((item) => item.kind === 'group' || item.kind === 'frame')
  const objects = visible.filter((item) => item.kind !== 'group' && item.kind !== 'frame')
  const silhouettes = rear.map(({ rect: member, colour }) =>
    `<rect data-stack-rear="true" x="${member.x}" y="${member.y}" width="${member.width}" height="${member.height}" rx="8" transform="rotate(${member.rotation} ${member.x + member.width / 2} ${member.y + member.height / 2})" fill="${readColour(colour)}" stroke="${dot}"/>`).join('')
  const gridShape = project.settings.grid === 'lines' ? `<path d="M${GRID_SPACING} 0H0V${GRID_SPACING}" fill="none" stroke="${dot}" stroke-width=".6"/>` : `<circle cx="1" cy="1" r=".9" fill="${dot}"/>`
  const background = options.background === 'transparent' ? '' : `<rect x="${x}" y="${y}" width="${worldWidth}" height="${worldHeight}" fill="${backdrop}"/>`
  const grid = options.background === 'grid' && project.settings.grid !== 'none' ? `<rect x="${x}" y="${y}" width="${worldWidth}" height="${worldHeight}" fill="url(#grid)"/>` : ''
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${worldWidth} ${worldHeight}"><title>${xml(project.name)}</title><defs><pattern id="grid" width="${GRID_SPACING}" height="${GRID_SPACING}" patternUnits="userSpaceOnUse">${gridShape}</pattern><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>${background}${grid}${containers.map((item) => fragments.get(item.id)).join('')}${silhouettes}${edgeLines.join('')}${objects.map((item) => fragments.get(item.id)).join('')}</svg>`
  return { blob: new Blob([markup], { type: 'image/svg+xml' }), width, height }
}

async function raster(svg: Awaited<ReturnType<typeof renderProjectSvg>>, type: 'image/png' | 'image/jpeg') {
  const url = URL.createObjectURL(svg.blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = svg.width
    canvas.height = svg.height
    const context = canvas.getContext('2d')
    requireValue(context, 'Raster export is unavailable in this browser.')
    if (type === 'image/jpeg') {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, svg.width, svg.height)
    }
    context.drawImage(image, 0, 0)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Image export failed.')), type, 0.92))
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function fitPdf(jpeg: Blob, sourceWidth: number, sourceHeight: number) {
  const pageWidth = sourceWidth > sourceHeight ? 842 : 595
  const pageHeight = sourceWidth > sourceHeight ? 595 : 842
  const scale = Math.min((pageWidth - 48) / sourceWidth, (pageHeight - 48) / sourceHeight)
  const width = (sourceWidth * scale).toFixed(2)
  const height = (sourceHeight * scale).toFixed(2)
  const x = ((pageWidth - Number(width)) / 2).toFixed(2)
  const y = ((pageHeight - Number(height)) / 2).toFixed(2)
  const draw = `q ${width} 0 0 ${height} ${x} ${y} cm /Im0 Do Q\n`
  const chunks: BlobPart[] = []
  const offsets: number[] = []
  let length = 0
  const write = (value: string) => { const bytes = encoder.encode(value); chunks.push(bytes); length += bytes.length }
  const addObject = (value: string) => { offsets.push(length); write(`${offsets.length} 0 obj\n${value}\nendobj\n`) }
  write('%PDF-1.4\n')
  addObject('<< /Type /Catalog /Pages 2 0 R >>')
  addObject('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  offsets.push(length)
  write(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${sourceWidth} /Height ${sourceHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.size} >>\nstream\n`)
  chunks.push(jpeg)
  length += jpeg.size
  write('\nendstream\nendobj\n')
  addObject(`<< /Length ${draw.length} >>\nstream\n${draw}endstream`)
  const xref = length
  write(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks, { type: 'application/pdf' })
}

function filename(title: string) {
  return title.trim().replace(/[^\p{L}\p{N}._ -]+/gu, '-').replace(/^[. ]+|[. ]+$/g, '').slice(0, 72) || 'canvas'
}

function download(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}

export async function exportProject(projects: readonly CanvasProject[], projectId: string, format: CanvasExportFormat, options: CanvasExportOptions = {}, assets: readonly CanvasAsset[] = []) {
  const root = projects.find((project) => project.id === projectId)
  requireValue(root, 'Canvas is missing.')
  if (format === 'croft' || format === 'zip') {
    download(await makeProjectPackage(projects, projectId, options, assets), `${filename(root.name)}.${format}`)
    return
  }
  const scoped = scopeProjects(projects, root, options)
  const audioBudget = newStaticAudioBudget()
  const render = async (project: CanvasProject) => {
    const svg = await renderProjectSvg(project, format === 'jpg' || format === 'pdf' ? { ...options, background: options.background === 'transparent' ? 'clean' : options.background } : options, assets, audioBudget)
    if (format === 'svg') return svg.blob
    const image = await raster(svg, format === 'png' ? 'image/png' : 'image/jpeg')
    return format === 'pdf' ? fitPdf(image, svg.width, svg.height) : image
  }
  if (scoped.length === 1) {
    download(await render(scoped[0]), `${filename(root.name)}.${format}`)
    return
  }
  requireValue(scoped.length <= 100, 'Export up to 100 canvases per visual archive.')
  const files: Record<string, Uint8Array> = {}
  let bytes = 0
  for (const [index, project] of scoped.entries()) {
    const blob = await render(project)
    bytes += blob.size
    requireValue(bytes <= limit.package - limit.manifest, 'Visual archive exceeds 120 MiB.')
    files[`${String(index + 1).padStart(3, '0')}-${filename(project.name)}.${format}`] = new Uint8Array(await blob.arrayBuffer())
  }
  download(new Blob([cloneBytes(zipSync(files, { level: 0 }))], { type: 'application/zip' }), `${filename(root.name)}-${format}.zip`)
}
