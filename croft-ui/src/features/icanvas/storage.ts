import { objectAssetIds, type CanvasAsset, type CanvasProject } from './model.ts'
import { assertStackMembership } from './stackPersistence.ts'
import { assertCanvasImageMetadata, assertEditedImageAsset, editedImageAssetIds } from './imagePersistence.ts'
import { assertProjectAudioAppearance, assertStyledAudioAsset, styledAudioAssetIds } from './audioAppearance.ts'
import { requireWorkspaceWriter } from './writerLock.ts'

export type { CanvasAsset } from './model'

export type CanvasRecovery = {
  id: string
  projectId: string
  createdAt: number
  project: CanvasProject
}

export type CanvasVersion = CanvasRecovery & {
  number: number
  notes: string
  descendants: CanvasProject[]
}

export type WorkspaceStorageState = {
  projects: CanvasProject[]
  assets: CanvasAsset[]
  versions: CanvasVersion[]
  recoveries: CanvasRecovery[]
}

const dbName = 'croft-icanvas'
const dbVersion = 1
const recoveryLimit = 10
const stores = {
  projects: 'projects',
  assets: 'assets',
  recoveries: 'recoveries',
  versions: 'versions',
} as const
type Store = typeof stores[keyof typeof stores]
let connection: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection
  const attempt = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('iCanvas needs access to browser local storage.'))
      return
    }
    const request = indexedDB.open(dbName, dbVersion)
    let cancelled = false
    request.onupgradeneeded = () => {
      if (cancelled) {
        request.transaction?.abort()
        return
      }
      const db = request.result
      db.createObjectStore(stores.projects, { keyPath: 'id' })
      db.createObjectStore(stores.assets, { keyPath: 'id' })
      db.createObjectStore(stores.recoveries, { keyPath: 'id' }).createIndex('projectId', 'projectId')
      const versions = db.createObjectStore(stores.versions, { keyPath: 'id' })
      versions.createIndex('projectId', 'projectId')
      versions.createIndex('projectNumber', ['projectId', 'number'], { unique: true })
    }
    request.onsuccess = () => {
      const db = request.result
      if (cancelled) {
        db.close()
        return
      }
      db.onversionchange = () => {
        db.close()
        if (connection === attempt) connection = undefined
      }
      db.onclose = () => {
        if (connection === attempt) connection = undefined
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('Could not open the iCanvas workspace.'))
    request.onblocked = () => {
      cancelled = true
      reject(new Error('Close other Croft tabs to finish opening the iCanvas workspace.'))
    }
  })
  connection = attempt
  void attempt.catch(() => {
    if (connection === attempt) connection = undefined
  })
  return attempt
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('An iCanvas storage request failed.'))
  })
}

async function transaction<T>(
  names: Store[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  try {
    if (mode === 'readwrite') requireWorkspaceWriter()
    const db = await openDatabase()
    const tx = mode === 'readwrite'
      ? db.transaction(names, mode, { durability: 'strict' })
      : db.transaction(names, mode)
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('The iCanvas save was interrupted.'))
    })
    void completed.catch(() => {})
    try {
      const outcome = await run(tx)
      await completed
      return outcome
    } catch (error) {
      try {
        tx.abort()
      } catch {
        // A request may already have aborted or closed the transaction.
      }
      await completed.catch(() => {})
      throw error
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new Error('Browser storage is full. Free some space or export a backup before retrying.', { cause: error })
    }
    throw error
  }
}

const getAllProjects = (tx: IDBTransaction) =>
  result<CanvasProject[]>(tx.objectStore(stores.projects).getAll())

function indexRows<T>(tx: IDBTransaction, store: Store, projectId: string) {
  return result<T[]>(tx.objectStore(store).index('projectId').getAll(projectId))
}

function mergeProjects(current: CanvasProject[], changed: CanvasProject[]) {
  if (new Set(changed.map(project => project.id)).size !== changed.length) {
    throw new Error('This operation includes duplicate canvas IDs.')
  }
  const merged = new Map(current.map(project => [project.id, project]))
  for (const project of changed) merged.set(project.id, project)
  return merged
}

function validateProject(project: CanvasProject) {
  if (!project.id || !project.name.trim() || !Array.isArray(project.objects) ||
      !Array.isArray(project.edges) || !Array.isArray(project.stops) ||
      ![project.camera.x, project.camera.y, project.camera.zoom, project.createdAt, project.updatedAt].every(Number.isFinite) ||
      project.camera.zoom <= 0) {
    throw new Error('The canvas contains invalid project data.')
  }
  const ids = new Set<string>()
  for (const object of project.objects) {
    if (!object.id || ids.has(object.id) ||
        ![object.x, object.y, object.width, object.height, object.rotation, object.opacity].every(Number.isFinite) ||
        object.width <= 0 || object.height <= 0) {
      throw new Error('The canvas contains an invalid or duplicate object.')
    }
    ids.add(object.id)
  }
  if (new Set(project.edges.map(edge => edge.id)).size !== project.edges.length ||
      new Set(project.stops.map(stop => stop.id)).size !== project.stops.length) {
    throw new Error('The canvas contains duplicate edge or presentation stop IDs.')
  }
  assertStackMembership(project.objects)
  assertCanvasImageMetadata(project)
  assertProjectAudioAppearance(project)
}

function validateHierarchy(projects: Map<string, CanvasProject>, changed: CanvasProject[]) {
  for (const project of changed) {
    const visited = new Set([project.id])
    let parentId = project.parentId
    while (parentId !== null) {
      if (visited.has(parentId)) throw new Error('A canvas cannot be moved inside its own SubCanvas.')
      const parent = projects.get(parentId)
      if (!parent) throw new Error('The parent canvas does not exist.')
      visited.add(parentId)
      parentId = parent.parentId
    }
  }
}

async function getProjectLineages(tx: IDBTransaction, projects: CanvasProject[]) {
  const store = tx.objectStore(stores.projects)
  const saved = new Map<string, CanvasProject | undefined>()
  const drafts = new Map(projects.map(project => [project.id, project]))
  async function read(id: string) {
    if (!saved.has(id)) saved.set(id, await result<CanvasProject | undefined>(store.get(id)))
    return saved.get(id)
  }
  for (const project of projects) {
    await read(project.id)
    let parentId = project.parentId
    const visited = new Set([project.id])
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = drafts.get(parentId) ?? await read(parentId)
      parentId = parent?.parentId ?? null
    }
  }
  return [...saved.values()].filter((project): project is CanvasProject => project !== undefined)
}

function referencedAssetIds(projects: CanvasProject[]): Set<string> {
  const ids = new Set<string>()
  for (const project of projects) {
    if (project.coverAssetId) ids.add(project.coverAssetId)
    if (project.iconAssetId) ids.add(project.iconAssetId)
    for (const object of project.objects) for (const assetId of objectAssetIds(object)) ids.add(assetId)
  }
  return ids
}

async function checkAssetReferences(
  tx: IDBTransaction,
  current: CanvasProject[],
  changed: CanvasProject[],
) {
  const oldIds = referencedAssetIds(current)
  const assetStore = tx.objectStore(stores.assets)
  for (const id of referencedAssetIds(changed)) {
    // A missing pre-existing asset should surface as an unavailable preview; do not block unrelated saves.
    if (!oldIds.has(id) && await result(assetStore.getKey(id)) === undefined) {
      throw new Error('An attachment required by this change is missing. Add it again and retry.')
    }
  }
  for (const id of editedImageAssetIds(changed)) assertEditedImageAsset(await result(assetStore.get(id)))
  for (const id of styledAudioAssetIds(changed)) assertStyledAudioAsset(await result(assetStore.get(id)))
}

function validateAsset(asset: CanvasAsset) {
  if (!asset.id || !asset.name || asset.size < 0 || !Number.isSafeInteger(asset.size) ||
      (asset.blob && asset.blob.size !== asset.size) || (asset.blob && asset.handle)) {
    throw new Error('The selected attachment has invalid metadata.')
  }
}

async function storeAssets(tx: IDBTransaction, assets: CanvasAsset[]) {
  const assetStore = tx.objectStore(stores.assets)
  for (const asset of assets) {
    validateAsset(asset)
    // Imported Blobs are immutable; links may be explicitly relinked under the same stable ID.
    const old: CanvasAsset | undefined = await result(assetStore.get(asset.id))
    if (old?.blob) {
      if (!asset.blob || old.name !== asset.name || old.mime !== asset.mime || old.size !== asset.size) {
        throw new Error('An imported attachment already uses this ID.')
      }
      continue
    }
    await result(assetStore.put(asset))
  }
}

async function writeProjects(tx: IDBTransaction, current: CanvasProject[], changed: CanvasProject[]) {
  const merged = mergeProjects(current, changed)
  validateHierarchy(merged, changed)
  const projectStore = tx.objectStore(stores.projects)
  const storedProjects = new Map(current.map(project => [project.id, project]))
  for (const project of changed) {
    validateProject(project)
    const previous = storedProjects.get(project.id)
    if (previous && previous.updatedAt > project.updatedAt) {
      throw new Error('This canvas was saved more recently in another tab. Reopen it before overwriting the saved work.')
    }
    await result(projectStore.put(project))
  }
}

export function getProjects(): Promise<CanvasProject[]> {
  return transaction([stores.projects], 'readonly', getAllProjects)
}

export function getWorkspaceStorageState(): Promise<WorkspaceStorageState> {
  return transaction(Object.values(stores), 'readonly', async tx => {
    const [projects, assets, versions, recoveries] = await Promise.all([
      getAllProjects(tx),
      result<CanvasAsset[]>(tx.objectStore(stores.assets).getAll()),
      result<CanvasVersion[]>(tx.objectStore(stores.versions).getAll()),
      result<CanvasRecovery[]>(tx.objectStore(stores.recoveries).getAll()),
    ])
    return { projects, assets, versions, recoveries }
  })
}

export function restoreWorkspaceStorageState(
  snapshot: WorkspaceStorageState,
  { merge = false }: { merge?: boolean } = {},
): Promise<void> {
  const state = structuredClone(snapshot)
  return transaction(Object.values(stores), 'readwrite', async tx => {
    if (!merge) {
      const counts = await Promise.all(Object.values(stores).map(name => result(tx.objectStore(name).count())))
      if (counts.some(Boolean)) throw new Error('This workspace already contains data. Use an additive restore.')
    }
    validateHierarchy(mergeProjects([], state.projects), state.projects)
    const ids = new Set(state.projects.map(project => project.id))
    const snapshots = [...state.versions, ...state.recoveries]
    for (const entry of snapshots) {
      if (entry.projectId !== entry.project.id || !ids.has(entry.projectId) || !Number.isFinite(entry.createdAt)) {
        throw new Error('A stored checkpoint does not match a restored canvas.')
      }
    }
    const content = [...state.projects, ...snapshots.map(entry => entry.project), ...state.versions.flatMap(version => version.descendants)]
    content.forEach(validateProject)
    const assets = new Map(state.assets.map(asset => [asset.id, asset]))
    if ([...referencedAssetIds(content)].some(id => !assets.has(id))) {
      throw new Error('The workspace backup is missing an attachment record.')
    }
    for (const id of editedImageAssetIds(content)) assertEditedImageAsset(assets.get(id))
    for (const id of styledAudioAssetIds(content)) assertStyledAudioAsset(assets.get(id))
    for (const asset of state.assets) {
      validateAsset(asset)
      await result(tx.objectStore(stores.assets).add(asset))
    }
    for (const project of state.projects) await result(tx.objectStore(stores.projects).add(project))
    for (const version of state.versions) await result(tx.objectStore(stores.versions).add(version))
    for (const recovery of state.recoveries) await result(tx.objectStore(stores.recoveries).add(recovery))
  })
}

export function saveProjects(
  projects: CanvasProject[],
  assets: CanvasAsset[] = [],
  options: { clearRecoveryFor?: string } = {},
): Promise<void> {
  const pendingProjects = structuredClone(projects)
  const names: Store[] = [stores.projects, stores.assets]
  if (options.clearRecoveryFor) names.push(stores.recoveries)
  return transaction(names, 'readwrite', async tx => {
    const current = await getProjectLineages(tx, pendingProjects)
    await storeAssets(tx, assets)
    await checkAssetReferences(tx, current, pendingProjects)
    await writeProjects(tx, current, pendingProjects)
    if (options.clearRecoveryFor) {
      const id = options.clearRecoveryFor
      const expected = pendingProjects.find(project => project.id === id)
      const saved: CanvasProject | undefined = await result(tx.objectStore(stores.projects).get(id))
      if (!expected || !saved || JSON.stringify(saved) !== JSON.stringify(expected)) {
        throw new Error('The saved canvas could not be verified. Recovery copies were kept.')
      }
      await deleteRecoveries(tx, id)
    }
  })
}

export function manualSave(projects: CanvasProject[], currentId: string, assets: CanvasAsset[] = []): Promise<void> {
  return saveProjects(projects, assets, { clearRecoveryFor: currentId })
}

export function getAsset(id: string): Promise<CanvasAsset | undefined> {
  return transaction([stores.assets], 'readonly', tx => result(tx.objectStore(stores.assets).get(id)))
}

export function getAssets(ids: Iterable<string>): Promise<CanvasAsset[]> {
  return transaction([stores.assets], 'readonly', async tx => {
    const store = tx.objectStore(stores.assets)
    const rows = await Promise.all([...new Set(ids)].map(id => result<CanvasAsset | undefined>(store.get(id))))
    return rows.filter((asset): asset is CanvasAsset => Boolean(asset))
  })
}

function compareRecoveries(a: CanvasRecovery, b: CanvasRecovery) {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id)
}

function sameState(left: CanvasProject, right: CanvasProject) {
  const { updatedAt: _left, ...leftContent } = left
  const { updatedAt: _right, ...rightContent } = right
  return JSON.stringify(leftContent) === JSON.stringify(rightContent)
}

export function getRecoveries(projectId: string): Promise<CanvasRecovery[]> {
  return transaction([stores.recoveries], 'readonly', async tx =>
    (await indexRows<CanvasRecovery>(tx, stores.recoveries, projectId)).sort(compareRecoveries))
}

export function saveRecovery(project: CanvasProject): Promise<CanvasRecovery | undefined> {
  const draft = structuredClone(project)
  validateProject(draft)
  return transaction([stores.recoveries, stores.projects, stores.assets], 'readwrite', async tx => {
    const saved: CanvasProject | undefined = await result(tx.objectStore(stores.projects).get(draft.id))
    if (!saved) throw new Error('Save the canvas once before creating a recovery copy.')
    await checkAssetReferences(tx, [saved], [draft])
    const list = (await indexRows<CanvasRecovery>(tx, stores.recoveries, draft.id)).sort(compareRecoveries)
    const newest = list[0]
    if (newest && sameState(newest.project, draft)) return undefined
    const entry = {
      id: crypto.randomUUID(),
      projectId: draft.id,
      createdAt: Math.max(Date.now(), (newest?.createdAt ?? 0) + 1),
      project: draft,
    }
    const store = tx.objectStore(stores.recoveries)
    await result(store.add(entry))
    for (const old of list.slice(recoveryLimit - 1)) await result(store.delete(old.id))
    return entry
  })
}

async function deleteRecoveries(tx: IDBTransaction, projectId: string) {
  const store = tx.objectStore(stores.recoveries)
  const keys = await result(store.index('projectId').getAllKeys(projectId))
  await Promise.all(keys.map(key => result(store.delete(key))))
}

function projectTree(projects: CanvasProject[], rootId: string): CanvasProject[] {
  const byId = new Map(projects.map(project => [project.id, project]))
  const root = byId.get(rootId)
  if (!root) throw new Error('The canvas could not be found.')
  const children = new Map<string, CanvasProject[]>()
  for (const project of projects) {
    if (!project.parentId) continue
    const siblings = children.get(project.parentId) ?? []
    siblings.push(project)
    children.set(project.parentId, siblings)
  }
  const tree: CanvasProject[] = []
  const seen = new Set<string>()
  const pending = [root]
  while (pending.length) {
    const project = pending.pop()!
    if (seen.has(project.id)) throw new Error('The canvas hierarchy contains a cycle.')
    seen.add(project.id)
    tree.push(project)
    const childProjects = children.get(project.id) ?? []
    for (let index = childProjects.length - 1; index >= 0; index--) pending.push(childProjects[index])
  }
  return tree
}

async function addVersion(
  tx: IDBTransaction,
  project: CanvasProject,
  descendants: CanvasProject[],
  notes: string,
): Promise<CanvasVersion> {
  const store = tx.objectStore(stores.versions)
  const sequence = await result(store.index('projectNumber').openKeyCursor(
    IDBKeyRange.bound([project.id, 0], [project.id, Number.MAX_SAFE_INTEGER]), 'prev',
  ))
  const entry = {
    id: crypto.randomUUID(),
    projectId: project.id,
    number: ((sequence?.key as [string, number] | undefined)?.[1] ?? 0) + 1,
    notes: notes.trim(),
    createdAt: Date.now(),
    project,
    descendants,
  }
  await result(store.add(entry))
  return entry
}

export function saveVersion(
  project: CanvasProject,
  notes = '',
  projects: CanvasProject[] = [],
): Promise<CanvasVersion> {
  const draft = structuredClone(project)
  const related = structuredClone(projects)
  return transaction([stores.projects, stores.assets, stores.versions], 'readwrite', async tx => {
    const current = await getAllProjects(tx)
    const drafts = [...related.filter(item => item.id !== draft.id), draft]
    const merged = [...mergeProjects(current, drafts).values()]
    const [head, ...descendants] = projectTree(merged, draft.id)
    const subtreeIds = new Set([head.id, ...descendants.map(item => item.id)])
    const changed = drafts.filter(item => subtreeIds.has(item.id))
    await checkAssetReferences(tx, current, changed)
    await writeProjects(tx, current, changed)
    return addVersion(tx, head, descendants, notes)
  })
}

export function getVersions(projectId: string): Promise<CanvasVersion[]> {
  return transaction([stores.versions], 'readonly', async tx =>
    (await indexRows<CanvasVersion>(tx, stores.versions, projectId)).sort((a, b) => b.number - a.number))
}

export function restoreVersion(project: CanvasProject, versionId: string): Promise<CanvasProject> {
  const draft = structuredClone(project)
  return transaction([stores.projects, stores.assets, stores.versions], 'readwrite', async tx => {
    const version: CanvasVersion | undefined = await result(tx.objectStore(stores.versions).get(versionId))
    if (!version || version.projectId !== draft.id) throw new Error('This version does not belong to the open canvas.')
    const current = await getAllProjects(tx)
    const retained = new Map(current.map(item => [item.id, item]))
    const existing = retained.get(draft.id)
    if (!existing) throw new Error('The canvas could not be found.')
    if (existing.updatedAt > draft.updatedAt) throw new Error('Reopen this canvas to load the latest edits before restoring.')

    const [, ...currentChildren] = projectTree(current, draft.id)
    const currentChildIds = new Set(currentChildren.map(item => item.id))
    const historical = new Set(version.descendants.map(item => item.id))
    if (version.descendants.some(item => retained.has(item.id) && !currentChildIds.has(item.id))) {
      throw new Error('A SubCanvas in this version was moved to another project. Move it back before restoring this version.')
    }

    const now = currentChildren.reduce((latest, item) => Math.max(latest, item.updatedAt + 1), Math.max(Date.now(), draft.updatedAt + 1))
    const restored = { ...version.project, parentId: existing.parentId, updatedAt: now }
    const children = version.descendants.map(item => ({ ...item, updatedAt: now }))
    // Restore the historical tree exactly. Preserve newer branches as standalone projects.
    const detached = currentChildren
      .filter(item => !historical.has(item.id) && (item.parentId === draft.id || historical.has(item.parentId ?? '')))
      .map(item => ({ ...item, parentId: null, updatedAt: now }))
    const changed = [restored, ...children, ...detached]
    await checkAssetReferences(tx, current, changed)
    validateProject(draft)
    await addVersion(tx, draft, currentChildren, `Before restoring v${version.number}`)
    await writeProjects(tx, current, changed)
    return restored
  })
}

export function restoreRecovery(project: CanvasProject, recoveryId: string): Promise<CanvasProject> {
  const draft = structuredClone(project)
  return transaction([stores.projects, stores.assets, stores.versions, stores.recoveries], 'readwrite', async tx => {
    const recovery: CanvasRecovery | undefined = await result(tx.objectStore(stores.recoveries).get(recoveryId))
    if (!recovery || recovery.projectId !== draft.id) throw new Error('This recovery copy does not belong to the open canvas.')
    const current = await getAllProjects(tx)
    const [existing, ...children] = projectTree(current, draft.id)
    if (existing.updatedAt > draft.updatedAt) throw new Error('Reopen this canvas to load the latest edits before restoring.')
    const restored = {
      ...recovery.project,
      parentId: existing.parentId,
      updatedAt: Math.max(Date.now(), draft.updatedAt + 1),
    }
    await checkAssetReferences(tx, current, [restored])
    validateProject(draft)
    await addVersion(tx, { ...draft, parentId: existing.parentId }, children, 'Before restoring recovery copy')
    await writeProjects(tx, current, [restored])
    return restored
  })
}

export function cloneProjectTree(
  projects: CanvasProject[],
  id: string,
  name: string,
  options: { preserveExternalCanvasLinks?: boolean } = {},
): CanvasProject[] {
  const title = name.trim()
  if (!title) throw new Error('Enter a name for the copied canvas.')
  const tree = structuredClone(projectTree(projects, id))
  const canvasIds = new Map(tree.map(project => [project.id, crypto.randomUUID()]))
  const allCanvasIds = new Set(projects.map(project => project.id))
  const now = Date.now()
  const clones = tree.map(project => {
    const objectIds = new Map(project.objects.map(object => [object.id, crypto.randomUUID()]))
    function localReference(target: string) {
      const replacement = objectIds.get(target) ?? canvasIds.get(target)
      if (replacement) return replacement
      if (options.preserveExternalCanvasLinks && allCanvasIds.has(target)) return target
      return undefined
    }
    return {
      ...project,
      id: canvasIds.get(project.id)!,
      parentId: canvasIds.get(project.parentId ?? '') ?? null,
      name: project.id === id ? title : project.name,
      createdAt: now,
      updatedAt: now,
      objects: project.objects.map(object => ({
        ...object,
        id: objectIds.get(object.id)!,
        parentId: object.parentId ? objectIds.get(object.parentId) : undefined,
        ...(object.stack ? { stack: { ...object.stack, order: object.stack.order.map(id => objectIds.get(id)!) } } : {}),
        targetId: object.targetId
          ? localReference(object.targetId) ?? (allCanvasIds.has(object.targetId) ? undefined : object.targetId)
          : undefined,
      })),
      edges: project.edges.flatMap(edge => {
        const from = localReference(edge.from)
        const to = localReference(edge.to)
        return from && to ? [{ ...edge, id: crypto.randomUUID(), from, to }] : []
      }),
      stops: project.stops.flatMap(stop => {
        const canvasId = localReference(stop.canvasId)
        return canvasId ? [{ ...stop, id: crypto.randomUUID(), canvasId }] : []
      }),
    }
  })
  clones.forEach(validateProject)
  return clones
}
