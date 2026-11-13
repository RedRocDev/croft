import { canvasAssetIds, readProject, safeMime } from './portability.ts'
import type { CanvasAsset, CanvasProject } from './model.ts'
import type { CanvasRecovery, CanvasVersion, WorkspaceStorageState } from './storage.ts'
import { assertStackMembership, containsCardExtensions } from './stackPersistence.ts'

export type WorkspaceBackupInventory = {
  projects: number; trashed: number; versions: number; recoveries: number; bytes: number;
  copied: CanvasAsset[]; links: CanvasAsset[]; absent: CanvasAsset[]; orphans: number;
  externalPages: number; unresolvedCanvases: number;
}

type BackupAsset = Omit<CanvasAsset, 'blob' | 'handle'> & { copied: boolean; linked?: boolean }
type SnapshotMetadata = Omit<WorkspaceStorageState, 'assets'> & { assets: BackupAsset[] }
type BackupSink = { write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void> }
type TransferOptions = { signal?: AbortSignal; progress?: (finished: number, total: number) => void }

const encoder = new TextEncoder()
const magicV1 = encoder.encode('CROFT WORKSPACE BACKUP 1\n')
const magicV2 = encoder.encode('CROFT WORKSPACE BACKUP 2\n')
const decoder = new TextDecoder('utf-8', { fatal: true })
const metadataLimit = 64 * 1024 ** 2
const mediaChunk = 1024 ** 2
const maxEntries = 200_000
const digestBytes = 32

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function data(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Malformed backup record.')
  return value as Record<string, unknown>
}

function items(value: unknown): unknown[] {
  check(Array.isArray(value) && value.length <= maxEntries, 'Backup contains an invalid or oversized list.')
  return value
}

function text(value: unknown, limit = 4096): string {
  check(typeof value === 'string' && value.length <= limit, 'Invalid backup text field.')
  return value
}

function key(value: unknown) {
  const id = text(value, 128)
  check(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id), 'Invalid backup identifier.')
  return id
}

function natural(value: unknown): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'Invalid backup quantity.')
  return value
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, index) => b[index] === value)
}

async function digest(bytes: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

function allScenes(snapshot: Omit<WorkspaceStorageState, 'assets'>) {
  return [...snapshot.projects, ...snapshot.versions.flatMap(version => [version.project, ...version.descendants]), ...snapshot.recoveries.map(recovery => recovery.project)]
}

export function inspectWorkspaceBackup(snapshot: WorkspaceStorageState): WorkspaceBackupInventory {
  const scenes = allScenes(snapshot)
  const used = canvasAssetIds(scenes)
  const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]))
  const projects = new Set(snapshot.projects.map(project => project.id))
  const copied = snapshot.assets.filter(asset => asset.blob)
  const links = snapshot.assets.filter(asset => !asset.blob && (asset.handle || asset.linked))
  const absent = snapshot.assets.filter(asset => !asset.blob && !asset.handle && !asset.linked)
  for (const id of used) if (!assets.has(id)) absent.push({ id, name: `Unavailable file (${id})`, mime: 'application/octet-stream', size: 0 })
  return {
    projects: snapshot.projects.length, trashed: snapshot.projects.filter(project => project.trashedAt !== undefined).length,
    versions: snapshot.versions.length, recoveries: snapshot.recoveries.length, bytes: copied.reduce((total, asset) => total + asset.blob!.size, 0),
    copied, links, absent, orphans: snapshot.assets.filter(asset => !used.has(asset.id)).length,
    externalPages: scenes.reduce((count, scene) => count + scene.objects.filter(object => object.kind === 'page' && object.targetId).length, 0),
    unresolvedCanvases: scenes.reduce((count, scene) => count + scene.objects.filter(object => object.kind === 'canvas' && object.targetId && !projects.has(object.targetId)).length, 0),
  }
}

function readBackupAsset(value: unknown): BackupAsset {
  const record = data(value)
  const name = text(record.name)
  const mime = text(record.mime, 127)
  check(name && !/[\\/\u0000-\u001f]/.test(name) && !/\.(?:bat|cmd|com|dll|exe|htm[l]?|js|lnk|msi|ps1|reg|scr|svgz?|url|xhtml|xml)[.\s]*$/i.test(name), 'Unsafe backup attachment name.')
  check(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mime), 'Invalid backup media type.')
  check(typeof record.copied === 'boolean' && (record.linked === undefined || typeof record.linked === 'boolean') && !(record.copied && record.linked), 'Invalid backup media disposition.')
  return { id: key(record.id), name, mime, size: natural(record.size), copied: record.copied, linked: record.linked || undefined }
}

function readRecovery(value: unknown): CanvasRecovery {
  const record = data(value)
  const project = readProject(record.project, maxEntries)
  const projectId = key(record.projectId)
  check(project.id === projectId, 'History entry has the wrong canvas ID.')
  return { id: key(record.id), projectId, createdAt: natural(record.createdAt), project }
}

function readVersion(value: unknown): CanvasVersion {
  const record = data(value)
  const number = natural(record.number)
  check(number > 0, 'Invalid version number.')
  return { ...readRecovery(record), number, notes: text(record.notes), descendants: items(record.descendants).map(project => readProject(project, maxEntries)) }
}

function unique<T extends { id: string }>(values: readonly T[], label: string) {
  const map = new Map(values.map(value => [value.id, value]))
  check(map.size === values.length, `Duplicate ${label} ID in backup.`)
  return map
}

function verifyParents<T extends { id: string; parentId?: string | null }>(rows: Map<string, T>, allowUnknown = false) {
  const checked = new Set<string>()
  for (const row of rows.values()) {
    const chain = new Set<string>()
    let entry: T | undefined = row
    while (entry && !checked.has(entry.id)) {
      check(!chain.has(entry.id), 'Backup contains a hierarchy cycle.')
      chain.add(entry.id)
      if (!entry.parentId) break
      entry = rows.get(entry.parentId)
      check(entry || allowUnknown, 'Backup contains a missing parent.')
    }
    for (const id of chain) checked.add(id)
  }
}

function metadata(bytes: Uint8Array, version: 1 | 2): SnapshotMetadata {
  const raw = data(JSON.parse(decoder.decode(bytes)) as unknown)
  const assets = items(raw.assets).map(readBackupAsset)
  const projects = items(raw.projects).map(project => readProject(project, maxEntries))
  const versions = items(raw.versions).map(readVersion)
  const recoveries = items(raw.recoveries).map(readRecovery)
  const projectMap = unique(projects, 'canvas')
  verifyParents(projectMap)
  const assetMap = unique(assets, 'attachment')
  unique(versions, 'version')
  unique(recoveries, 'recovery')
  for (const { projectId } of [...versions, ...recoveries]) check(projectMap.has(projectId), 'A version or recovery has no owner canvas.')
  const versionKeys = new Set(versions.map(version => `${version.projectId}:${version.number}`))
  check(versionKeys.size === versions.length, 'Duplicate version number in backup.')
  for (const version of versions) verifyParents(unique([version.project, ...version.descendants], 'version canvas'), true)
  const scenes = allScenes({ projects, versions, recoveries })
  check(version === 2 || !containsCardExtensions(scenes), 'Cards and stacks require a version 2 Croft backup.')
  for (const scene of scenes) {
    const objects = unique(scene.objects, 'object')
    unique(scene.edges, 'edge')
    unique(scene.stops, 'presentation stop')
    verifyParents(objects)
    assertStackMembership(scene.objects)
    for (const item of scene.objects) check(!item.parentId || ['frame', 'group', 'stack'].includes(objects.get(item.parentId)!.kind), 'Invalid object container in backup.')
    for (const edge of scene.edges) check(objects.has(edge.from) && objects.has(edge.to), 'An edge in the backup refers to a missing object.')
    for (const id of canvasAssetIds([scene])) check(assetMap.has(id), 'Backup refers to an attachment not listed in the inventory.')
  }
  return { projects, assets, versions, recoveries }
}

export function prepareWorkspaceBackup(snapshot: WorkspaceStorageState) {
  const ids = new Set(snapshot.assets.map(asset => asset.id))
  const missing = inspectWorkspaceBackup(snapshot).absent.filter(entry => !ids.has(entry.id))
  const assets = [...snapshot.assets, ...missing].map(asset => {
    check(!asset.blob || asset.size === asset.blob.size, 'An attachment size does not match its stored bytes.')
    return { id: asset.id, name: asset.name, mime: asset.mime, size: asset.size, copied: Boolean(asset.blob), linked: Boolean(asset.handle || asset.linked) || undefined }
  })
  const { projects, versions, recoveries } = snapshot
  const version = containsCardExtensions(allScenes(snapshot)) ? 2 : 1
  const bytes = encoder.encode(JSON.stringify({ projects, versions, recoveries, assets }))
  check(bytes.byteLength <= metadataLimit, 'Workspace history and canvas metadata exceed the 64 MiB backup header limit. Data were not backed up.')
  metadata(bytes, version)
  return { manifest: bytes, magic: version === 2 ? magicV2 : magicV1, blobs: snapshot.assets.flatMap(asset => asset.blob ? [asset.blob] : []) }
}

export async function writeWorkspaceBackup({ manifest, magic, blobs }: ReturnType<typeof prepareWorkspaceBackup>, sink: BackupSink, options: TransferOptions = {}) {
  options.signal?.throwIfAborted()
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, manifest.length, true)
  await sink.write(magic)
  await sink.write(length)
  await sink.write(await digest(manifest))
  await sink.write(manifest)
  const total = blobs.reduce((sum, blob) => sum + blob.size, 0)
  let finished = 0
  // BYOB moves the same buffer between the stream and this consumer. Await each
  // sink write before handing it back to the next read.
  let buffer = new ArrayBuffer(mediaChunk)
  for (const blob of blobs) {
    if (!blob.size) continue
    const reader = blob.stream().getReader({ mode: 'byob' })
    try {
      for (let offset = 0; offset < blob.size; ) {
        const count = Math.min(mediaChunk, blob.size - offset)
        let filled = 0
        while (filled < count) {
          options.signal?.throwIfAborted()
          const { done, value } = await reader.read(new Uint8Array(buffer, filled, count - filled))
          check(!done && value?.byteLength, 'An attachment became unreadable during backup.')
          buffer = value.buffer
          filled += value.byteLength
        }
        const bytes = new Uint8Array(buffer, 0, count)
        await sink.write(await digest(bytes))
        await sink.write(bytes)
        offset += count
        finished += count
        options.progress?.(finished, total)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  options.signal?.throwIfAborted()
}

export async function streamWorkspaceBackup(snapshot: WorkspaceStorageState, sink: BackupSink, options: TransferOptions = {}) {
  options.signal?.throwIfAborted()
  await writeWorkspaceBackup(prepareWorkspaceBackup(snapshot), sink, options)
}

export async function parseWorkspaceBackup(file: Blob, options: TransferOptions = {}): Promise<WorkspaceStorageState> {
  let offset = 0
  async function read(size: number) {
    options.signal?.throwIfAborted()
    check(Number.isSafeInteger(offset + size) && offset + size <= file.size, 'Workspace backup is incomplete.')
    const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer())
    offset += size
    return bytes
  }
  const magic = await read(magicV1.length)
  const version = bytesEqual(magic, magicV2) ? 2 : 1
  check(version === 2 || bytesEqual(magic, magicV1), 'Unsupported Croft workspace backup format.')
  const length = new DataView((await read(4)).buffer).getUint32(0, true)
  check(length > 0 && length <= metadataLimit, 'Workspace backup header is oversized.')
  const manifestHash = await read(digestBytes)
  const manifest = await read(length)
  check(bytesEqual(await digest(manifest), manifestHash), 'Workspace backup metadata failed its checksum.')
  const { projects, versions, recoveries, assets: entries } = metadata(manifest, version)
  const embedded = entries.filter(asset => asset.copied)
  const total = embedded.reduce((sum, asset) => sum + asset.size, 0)
  const payload = embedded.reduce((sum, asset) => sum + asset.size + Math.ceil(asset.size / mediaChunk) * digestBytes, 0)
  check(Number.isSafeInteger(offset + payload) && offset + payload === file.size, 'Workspace backup byte count does not match its inventory.')
  const reader = file.slice(offset).stream().getReader({ mode: 'byob' })
  let buffer = new ArrayBuffer(mediaChunk)
  let hashBuffer = new ArrayBuffer(digestBytes)
  async function fill(memory: ArrayBuffer, count: number) {
    let filled = 0
    while (filled < count) {
      options.signal?.throwIfAborted()
      const { done, value } = await reader.read(new Uint8Array(memory, filled, count - filled))
      check(!done && value?.byteLength, 'Workspace backup is incomplete.')
      memory = value.buffer
      filled += value.byteLength
    }
    offset += count
    return memory
  }
  let finished = 0
  const assets: CanvasAsset[] = []
  try {
    for (const { copied, linked, id, name, mime, size } of entries) {
      if (!copied) {
        assets.push({ id, name, mime, size, linked })
        continue
      }
      const pieces: Blob[] = []
      let type = mime
      for (let start = 0; start < size; start += mediaChunk) {
        const count = Math.min(mediaChunk, size - start)
        hashBuffer = await fill(hashBuffer, digestBytes)
        const chunkStart = offset
        buffer = await fill(buffer, count)
        const bytes = new Uint8Array(buffer, 0, count)
        check(bytesEqual(await digest(bytes), new Uint8Array(hashBuffer)), `An attachment failed its checksum: ${name}.`)
        if (!start) type = safeMime(mime, bytes)
        pieces.push(file.slice(chunkStart, offset))
        finished += count
        options.progress?.(finished, total)
      }
      assets.push({ id, name, mime: type, size, blob: new Blob(pieces, { type }) })
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return { projects, versions, recoveries, assets }
}

export function cloneWorkspaceBackup(snapshot: WorkspaceStorageState): WorkspaceStorageState {
  const projectIds = new Map<string, string>()
  const assetIds = new Map<string, string>()
  const objectIds = new Map<string, Map<string, string>>()
  const edgeIds = new Map<string, Map<string, string>>()
  const stopIds = new Map<string, Map<string, string>>()
  function translate(map: Map<string, string>, id: string) {
    const existing = map.get(id)
    if (existing) return existing
    const newId = crypto.randomUUID()
    map.set(id, newId)
    return newId
  }
  function forProject(maps: Map<string, Map<string, string>>, id: string) {
    const map = maps.get(id) ?? new Map<string, string>()
    maps.set(id, map)
    return map
  }
  function clone(project: CanvasProject): CanvasProject {
    const objects = forProject(objectIds, project.id)
    const edges = forProject(edgeIds, project.id)
    const stops = forProject(stopIds, project.id)
    return {
      ...project, id: translate(projectIds, project.id), parentId: project.parentId === null ? null : translate(projectIds, project.parentId),
      coverAssetId: project.coverAssetId && translate(assetIds, project.coverAssetId), iconAssetId: project.iconAssetId && translate(assetIds, project.iconAssetId),
      objects: project.objects.map(object => ({
        ...object, id: translate(objects, object.id), parentId: object.parentId && translate(objects, object.parentId),
        assetId: object.assetId && translate(assetIds, object.assetId),
        targetId: object.kind === 'canvas' && object.targetId ? translate(projectIds, object.targetId) : object.targetId,
        ...(object.back ? { back: { ...object.back, assetId: object.back.assetId && translate(assetIds, object.back.assetId) } } : {}),
        ...(object.stack ? { stack: { ...object.stack, order: object.stack.order.map(id => translate(objects, id)) } } : {}),
      })),
      edges: project.edges.map(edge => ({ ...edge, id: translate(edges, edge.id), from: translate(objects, edge.from), to: translate(objects, edge.to) })),
      stops: project.stops.map(stop => ({ ...stop, id: translate(stops, stop.id), canvasId: translate(projectIds, stop.canvasId) })),
    }
  }
  return {
    projects: snapshot.projects.map(clone), assets: snapshot.assets.map(asset => ({ ...asset, id: translate(assetIds, asset.id) })),
    versions: snapshot.versions.map(version => ({ ...version, id: crypto.randomUUID(), projectId: translate(projectIds, version.projectId), project: clone(version.project), descendants: version.descendants.map(clone) })),
    recoveries: snapshot.recoveries.map(recovery => ({ ...recovery, id: crypto.randomUUID(), projectId: translate(projectIds, recovery.projectId), project: clone(recovery.project) })),
  }
}
