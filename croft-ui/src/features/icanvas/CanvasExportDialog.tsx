import { useEffect, useMemo, useState } from 'react'
import type { CanvasAsset, CanvasProject } from './model'
import { CanvasDialog } from './ProjectViews'
import { canvasAssetIds, exportProject, projectExportInventory, type CanvasExportFormat, type CanvasExportOptions } from './portability'
import { getAssets } from './storage'
import { formatMiB } from './CanvasBackupDialog'

export function CanvasExportDialog({ close, projects, project, selectedIds, dark, openBackup }: {
  close: () => void
  projects: readonly CanvasProject[]
  project: CanvasProject
  selectedIds: readonly string[]
  dark: boolean
  openBackup?: () => void
}) {
  const [format, setFormat] = useState<CanvasExportFormat>('croft')
  const [scope, setScope] = useState<NonNullable<CanvasExportOptions['scope']>>('project')
  const [background, setBackground] = useState<NonNullable<CanvasExportOptions['background']>>('clean')
  const [assets, setAssets] = useState<CanvasAsset[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const assetIds = useMemo(() => [...canvasAssetIds(projects)], [projects])
  useEffect(() => {
    let active = true
    void getAssets(assetIds).then(rows => { if (active) setAssets(rows) }, (reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [assetIds])
  const editable = format === 'croft' || format === 'zip'
  const options: CanvasExportOptions = { scope, selectedIds, theme: dark ? 'dark' : 'light', background }
  const inventory = assets ? projectExportInventory(projects, project, options, assets) : undefined
  const limited = editable && !!inventory && (inventory.overLimit.length > 0 || inventory.exceedsPackage)

  return <CanvasDialog title="Export canvas" close={() => { if (!busy) close() }}>
    <div className="ic-form">
      <label>Format<select value={format} onChange={event => {
        const value = event.target.value as CanvasExportFormat
        setFormat(value)
        if (background === 'transparent' && value !== 'svg' && value !== 'png') setBackground('clean')
      }}>{(['croft', 'zip', 'svg', 'png', 'jpg', 'pdf'] as const).map(item => <option key={item} value={item}>{item === 'croft' ? '.croft editable project' : item.toUpperCase()}</option>)}</select></label>
      <label>Scope<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
        <option value="canvas">Current Canvas</option><option value="project">Include all SubCanvases</option>
        <option value="selection" disabled={!selectedIds.length}>Selected Objects</option>
      </select></label>
      {!editable && <label>Background<select value={background} onChange={event => setBackground(event.target.value as typeof background)}>
        <option value="clean">Clean</option><option value="grid">Include Canvas Background</option>
        <option value="transparent" disabled={format !== 'png' && format !== 'svg'}>Transparent</option>
      </select></label>}
      {inventory ? <section aria-label="Portable export inventory">
        <p><strong>{inventory.projectCount} canvas{inventory.projectCount === 1 ? '' : 'es'} in scope.</strong></p>
        {editable ? <>
          <p>{inventory.included.length} embedded files ({formatMiB(inventory.bytes)}) before package overhead. Versions and recoveries stay in the workspace.</p>
          <p>{inventory.relink.length} linked files need relinking, {inventory.missing.length} files are already missing, and {inventory.outside.length} canvas links point outside the scope. {inventory.externalPages.length} Croft page links point outside iCanvas.</p>
          {inventory.relink.length > 0 && <details><summary>Files that require relinking</summary><ul>{inventory.relink.slice(0, 30).map(asset => <li key={asset.id}>{asset.name}</li>)}</ul>
            {inventory.relink.length > 30 && <p>{inventory.relink.length - 30} more links are listed in the package.</p>}
          </details>}
          {inventory.missing.length > 0 && <p>Missing media produce unavailable placeholders in the imported project.</p>}
          <p>Portable limit: {inventory.maxAssetMiB} MiB per embedded file and {inventory.maxPackageMiB} MiB per package.</p>
          {limited && <p role="alert">This scope exceeds the portable export limit. Use Workspace Backup to retain the larger attachments, or choose a smaller scope for a portable copy.</p>}
          {inventory.overLimit.length > 0 && <ul aria-label="Files above the portable limit">{inventory.overLimit.slice(0, 30).map(asset => <li key={asset.id}>{asset.name} ({formatMiB(asset.size)})</li>)}</ul>}
        </> : <>
          <p>Visual exports contain the visible layout. Audio, video, linked files, unavailable files and unsupported images appear as labels. Embedded raster images are limited to 16 MiB each, with an additional per-canvas image budget.</p>
          <p>{inventory.relink.length} linked and {inventory.missing.length} missing attachments in scope. Versions and recovery history are excluded. Visual archives are limited to 100 canvases and 120 MiB. PDF fits each canvas on one A4 page.</p>
        </>}
      </section> : !error && <p role="status">Reading file inventory…</p>}
      <div className="ic-dialog-actions">
        {openBackup && <button className="ic-button" type="button" disabled={busy} onClick={openBackup}>Workspace backup…</button>}
        <button className="ic-button ic-primary" type="button" disabled={busy || !inventory || limited} onClick={() => {
          setBusy(true)
          setError('')
          void exportProject(projects, project.id, format, options, assets).then(close).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
        }}>{busy ? 'Exporting…' : 'Export'}</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  </CanvasDialog>
}
