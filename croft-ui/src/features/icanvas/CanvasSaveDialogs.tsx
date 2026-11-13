import { ArrowUpRight, History, Save, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { CanvasThumbnail } from './CanvasVisuals'
import { CanvasDialog } from './ProjectViews'
import { descendants, type CanvasProject } from './model'
import {
  cloneProjectTree, getAssets, getRecoveries, getVersions, restoreRecovery, restoreVersion, saveVersion,
  type CanvasRecovery, type CanvasVersion,
} from './storage'

type DialogMode = 'versions' | 'recovery' | 'copy' | 'checkpoint'
type Props = {
  mode: DialogMode
  project: CanvasProject
  projects: CanvasProject[]
  close: () => void
  flush: () => Promise<void>
  write: (projects: CanvasProject[]) => Promise<void>
  refresh: () => Promise<void>
  onOpen: (id: string) => void
}
type Entry = CanvasRecovery | CanvasVersion

const titles: Record<DialogMode, string> = {
  versions: 'Version history',
  recovery: 'Recovery copies',
  copy: 'Save As…',
  checkpoint: 'Save VC',
}
const isVersion = (entry: Entry): entry is CanvasVersion => 'number' in entry
const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function objectDelta(current: CanvasProject, previous: CanvasProject) {
  const currentObjects = new Map(current.objects.map(object => [object.id, object]))
  const previousObjects = new Map(previous.objects.map(object => [object.id, object]))
  const added = [...currentObjects.keys()].filter(id => !previousObjects.has(id)).length
  const removed = [...previousObjects.keys()].filter(id => !currentObjects.has(id)).length
  const changed = [...currentObjects].filter(([id, object]) => previousObjects.has(id)
    && JSON.stringify(previousObjects.get(id)) !== JSON.stringify(object)).length
  return `${added} added · ${removed} removed · ${changed} changed since this copy`
}

export function CanvasSaveDialogs({ mode, project, projects, close, flush, write, refresh, onOpen }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<Entry>()
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(`${project.name} copy`)
  const [notes, setNotes] = useState('')
  const [preserveLinks, setPreserveLinks] = useState(false)
  const [hasLinkedFile, setHasLinkedFile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(mode === 'versions' || mode === 'recovery')
  const [error, setError] = useState('')
  const children = descendants(projects, project.id)

  useEffect(() => {
    if (mode !== 'versions' && mode !== 'recovery') return
    let active = true
    const load = mode === 'versions' ? getVersions(project.id) : getRecoveries(project.id)
    void load.then(items => {
      if (active) setEntries(items)
    }).catch(reason => {
      if (active) setError(String(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [mode, project.id])

  useEffect(() => {
    if (mode !== 'copy') return
    const tree = [project, ...descendants(projects, project.id)]
    const assetIds = tree.flatMap(canvas => [
      ...(canvas.coverAssetId ? [canvas.coverAssetId] : []),
      ...canvas.objects.flatMap(object => object.assetId ? [object.assetId] : []),
    ])
    let active = true
    void getAssets(assetIds).then(assets => { if (active) setHasLinkedFile(assets.some(asset => asset.handle || asset.linked)) })
      .catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [mode, project, projects])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (mode === 'copy' && !name.trim()) return
    void run(async () => {
      await flush()
      if (mode === 'checkpoint') {
        await saveVersion(project, notes, projects)
        await refresh()
        close()
      } else if (mode === 'copy') {
        const copied = cloneProjectTree(projects, project.id, name, { preserveExternalCanvasLinks: preserveLinks })
        await write(copied)
        close()
        onOpen(copied[0].id)
      }
    })
  }

  function restore() {
    if (!selected) return
    void run(async () => {
      await flush()
      if (isVersion(selected)) {
        await restoreVersion(project, selected.id)
      } else {
        await restoreRecovery(project, selected.id)
      }
      await refresh()
      close()
    })
  }

  function preview(entry: Entry) {
    setSelected(entry)
    setConfirming(false)
    setError('')
  }

  return <CanvasDialog title={titles[mode]} close={() => { if (!busy) close() }}>
    {(mode === 'copy' || mode === 'checkpoint') ? <form className="ic-form" onSubmit={submit}>
      {mode === 'copy' ? <>
        <label>Name<input autoFocus value={name} maxLength={120} required onChange={event => setName(event.target.value)} /></label>
        <p className="ic-feedback">{children.length
          ? `Includes ${children.length} ${children.length === 1 ? 'SubCanvas' : 'SubCanvases'}.`
          : 'Creates an independent copy of this canvas.'}</p>
        {hasLinkedFile && <p className="ic-feedback" role="status">Linked files in the copy still need access to their original files.</p>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <input style={{ width: 'auto' }} type="checkbox" checked={preserveLinks} onChange={event => setPreserveLinks(event.target.checked)} /> Keep links to other canvas projects
        </label>
      </> : <>
        <label>Version notes (optional)<textarea autoFocus rows={3} maxLength={600} value={notes} onChange={event => setNotes(event.target.value)} /></label>
        <p className="ic-feedback">Creates a numbered checkpoint of this canvas and its SubCanvases.</p>
      </>}
      {error && <p className="ic-error" role="alert">{error}</p>}
      <div className="ic-dialog-actions">
        <button type="button" className="ic-button" onClick={close} disabled={busy}>Cancel</button>
        <button className="ic-button ic-primary" disabled={busy || (mode === 'copy' && !name.trim())}>
          <Save size={14} /> {busy ? 'Saving…' : mode === 'copy' ? 'Create copy' : 'Save version'}
        </button>
      </div>
    </form> : <div className="ic-form">
      {loading && <p className="ic-feedback" role="status">Loading…</p>}
      {!loading && !entries.length && !error && <p className="ic-feedback">
        {mode === 'versions' ? 'Use Save VC to create your first numbered version.' : 'No temporary recovery copies for this canvas.'}
      </p>}
      {!!entries.length && <div className="ic-save-history" style={{ display: 'grid', gap: 5, maxHeight: 190, overflow: 'auto' }}>
        {entries.map(entry => <button type="button" className="ic-button" key={entry.id} aria-pressed={selected?.id === entry.id}
          disabled={busy} style={{ justifyContent: 'space-between', textAlign: 'left' }} onClick={() => preview(entry)}>
          <span><History size={13} style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 6 }} />
            {isVersion(entry) ? `v${entry.number}` : 'Recovery'} · {formatTime(entry.createdAt)}
            {isVersion(entry) && entry.notes ? ` · ${entry.notes}` : ''}
          </span><ArrowUpRight size={13} />
        </button>)}
      </div>}
      {selected && <section aria-label="Saved canvas preview">
        <header className="ic-row" style={{ justifyContent: 'space-between' }}>
          <strong>{selected.project.name}</strong><button type="button" className="ic-icon" aria-label="Close preview" disabled={busy}
            onClick={() => { setSelected(undefined); setConfirming(false) }}><X size={14} /></button>
        </header>
        <CanvasThumbnail project={selected.project} />
        <p className="ic-feedback">{selected.project.objects.length} objects · {selected.project.edges.length} links{isVersion(selected) ? ` · ${(selected.descendants ?? []).length} SubCanvases` : ''}</p>
        <p className="ic-feedback">{objectDelta(project, selected.project)}</p>
      </section>}
      {confirming && <p className="ic-feedback" role="status">{selected && isVersion(selected)
        ? 'Restore this version and its SubCanvases? Your current tree is kept as a new version. Newer branches from this project become separate projects.'
        : 'Restore this recovery copy? Your current canvas is kept as a version.'}</p>}
      {error && <p className="ic-error" role="alert">{error}</p>}
      <div className="ic-dialog-actions">
        <button type="button" className="ic-button" disabled={busy} onClick={confirming ? () => setConfirming(false) : close}>{confirming ? 'Keep current' : 'Close'}</button>
        {selected && <button type="button" className="ic-button ic-primary" disabled={busy} onClick={confirming ? restore : () => setConfirming(true)}>
          {busy ? 'Restoring…' : confirming ? 'Confirm restore' : 'Restore…'}
        </button>}
      </div>
    </div>}
  </CanvasDialog>
}
