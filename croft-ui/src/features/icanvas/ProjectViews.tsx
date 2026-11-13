import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Archive, ChevronDown, ChevronRight, Ellipsis, FolderOpen, Plus, X } from 'lucide-react'
import { CanvasThumbnail, useAssetUrl } from './CanvasVisuals'
import { importProject } from './portability'
import { projectIcons, type CanvasAsset, type CanvasProject } from './model'

export function CanvasDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const current = dialog.current
    current?.showModal()
    return () => current?.close()
  }, [])
  return <dialog ref={dialog} className="ic-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close() }}
    onClick={event => { if (event.currentTarget === event.target) close() }}>
    <header><h2>{title}</h2><button className="ic-icon" aria-label="Close dialog" onClick={close}><X /></button></header>
    {children}
  </dialog>
}

export function ProjectIcon({ project }: { project: CanvasProject }) {
  const { url } = useAssetUrl(project.iconAssetId)
  return <span className="ic-project-icon" aria-hidden="true">{url ? <img src={url} alt="" /> : project.icon}</span>
}

export function ProjectCards({ projects, create, open, details, importProjects, error, canEdit, openBackup }: {
  projects: CanvasProject[]; create: () => void; open: (id: string) => void; details: (project: CanvasProject) => void
  importProjects: (projects: CanvasProject[], assets?: CanvasAsset[]) => Promise<void>; error: string; canEdit: boolean; openBackup: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [importStatus, setImportStatus] = useState('')
  const roots = projects.filter(project => !project.parentId)
  return <section className="ic-home-projects" aria-label="Canvas projects">
    <div className="ic-home-project-head">
      <h2>Projects</h2>
      <div className="ic-row">
        <button className="ic-button" onClick={openBackup}><Archive size={15} /> Backup &amp; restore</button>
        <button className="ic-button" disabled={!canEdit} onClick={() => input.current?.click()}><FolderOpen size={15} /> Import</button>
        <button className="ic-button ic-primary" disabled={!canEdit} onClick={create}><Plus size={15} /> New Project</button>
      </div>
    </div>
    <input ref={input} type="file" accept=".croft,.zip" hidden onChange={event => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (!file) return
      setImportStatus('Reading project…')
      void importProject(file).then(async result => {
        await importProjects(result.projects, result.assets)
        setImportStatus('Project imported.')
      }).catch(reason => setImportStatus(String(reason)))
    }} />
    {(importStatus || error) && <p className="ic-feedback" role="status">{error || importStatus}</p>}
    <div className="ic-project-cards">
      {roots.map(project => <article className="ic-project-card" key={project.id}>
        <button className="ic-project-open" onClick={() => open(project.id)}>
          <CanvasThumbnail project={project} />
          <strong><ProjectIcon project={project} /> {project.name}</strong>
          {project.description && <span className="ic-card-description">{project.description}</span>}
          <time dateTime={new Date(project.updatedAt).toISOString()}>{new Date(project.updatedAt).toLocaleDateString()}</time>
        </button>
        <button className="ic-icon ic-card-options" disabled={!canEdit} aria-label={'Project details for ' + project.name} title="Project details"
          onClick={() => details(project)}><Ellipsis /></button>
      </article>)}
    </div>
  </section>
}

export function ProjectTree({ projects, current, open }: { projects: CanvasProject[]; current: string; open: (id: string) => void }) {
  const [expanded, setExpanded] = useState(new Set<string>())
  function branch(parent: string | null, depth: number, chain: ReadonlySet<string>): ReactNode {
    return projects.filter(project => project.parentId === parent && !chain.has(project.id)).map(project => {
      const hasChildren = projects.some(child => child.parentId === project.id)
      const visible = expanded.has(project.id)
      return <li key={project.id}>
        <div className="ic-tree-row" style={{ paddingInlineStart: depth * 14 }}>
          {hasChildren ? <button className="ic-icon" aria-label={(visible ? 'Collapse ' : 'Expand ') + project.name}
            aria-expanded={visible} onClick={() => setExpanded(previous => {
              const next = new Set(previous)
              if (next.has(project.id)) next.delete(project.id)
              else next.add(project.id)
              return next
            })}>{visible ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="ic-tree-spacer" />}
          <button className="side-link ic-tree-link" title={project.name} aria-current={current === project.id ? 'page' : undefined}
            onClick={() => open(project.id)}><ProjectIcon project={project} /><span>{project.name}</span></button>
        </div>
        {visible && <ul>{branch(project.id, depth + 1, new Set([...chain, project.id]))}</ul>}
      </li>
    })
  }
  if (!projects.length) return null
  return <section className="ic-project-tree" aria-label="Project hierarchy">
    <h2>Projects</h2>
    <ul>{branch(null, 0, new Set())}</ul>
  </section>
}

export function ProjectDetails({ project, close, onSave }: {
  project: CanvasProject; close: () => void; onSave: (project: CanvasProject, assets?: CanvasAsset[]) => Promise<void>
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [icon, setIcon] = useState(project.icon)
  const [iconFile, setIconFile] = useState<File>()
  const [removeIcon, setRemoveIcon] = useState(false)
  const [cover, setCover] = useState<File>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const validCovers = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
  async function rasterAsset(file: File | undefined, sizeLimit: number, maxDimension: number, label: string): Promise<CanvasAsset | undefined> {
    if (!file) return undefined
    if (!validCovers.includes(file.type) || file.size > sizeLimit * 1024 * 1024) throw new Error(`${label}: choose a raster image under ${sizeLimit} MiB.`)
    const image = await createImageBitmap(file)
    try {
      if (image.width > maxDimension || image.height > maxDimension) throw new Error(`${label}: maximum dimensions are ${maxDimension} × ${maxDimension} pixels.`)
    } finally { image.close() }
    return { id: crypto.randomUUID(), name: file.name, mime: file.type, size: file.size, blob: file }
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const [coverAsset, iconAsset] = await Promise.all([rasterAsset(cover, 12, 8192, 'Cover'), rasterAsset(iconFile, 2, 1024, 'Icon')])
      await onSave({ ...project, name: name.trim(), description: description.trim(), icon,
        iconAssetId: iconAsset?.id ?? (removeIcon ? undefined : project.iconAssetId),
        coverAssetId: coverAsset?.id ?? project.coverAssetId, updatedAt: Date.now() },
      [coverAsset, iconAsset].filter((item): item is CanvasAsset => !!item))
    } catch (reason) {
      setError(String(reason))
      setSaving(false)
    }
  }
  return <CanvasDialog title={project.name ? 'Project Details' : 'New canvas project'} close={() => { if (!saving) close() }}>
    <form className="ic-form" onSubmit={save}>
      <label>Name<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
      <label>Description<textarea rows={3} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <fieldset><legend>Icon</legend><div className="ic-row">{projectIcons.map(item =>
        <button type="button" className="ic-button" key={item} aria-label={'Choose icon ' + item}
          aria-pressed={icon === item && !iconFile && (!project.iconAssetId || removeIcon)}
          onClick={() => { setIcon(item); setIconFile(undefined); setRemoveIcon(true) }}>{item}</button>)}</div>
        {project.iconAssetId && !removeIcon && !iconFile && <p className="ic-row"><ProjectIcon project={project} /> Current uploaded icon</p>}
        <label>Upload icon<input key={removeIcon ? 'builtin' : 'custom'} type="file" accept={validCovers.join(',')}
          onChange={event => setIconFile(event.currentTarget.files?.[0])} /></label>
      </fieldset>
      <label>Cover image<input type="file" accept={validCovers.join(',')} onChange={event => setCover(event.currentTarget.files?.[0])} /></label>
      {error && <p role="alert" className="ic-error">{error}</p>}
      <div className="ic-dialog-actions"><button type="button" className="ic-button" disabled={saving} onClick={close}>Cancel</button>
        <button className="ic-button ic-primary" disabled={saving || !name.trim()}>{saving ? 'Saving…' : project.name ? 'Save details' : 'Create canvas'}</button></div>
    </form>
  </CanvasDialog>
}
