import { useEffect, useRef, useState } from 'react'
import { CanvasDialog } from './ProjectViews'
import { getWorkspaceStorageState, restoreWorkspaceStorageState, type WorkspaceStorageState } from './storage'
import { cloneWorkspaceBackup, inspectWorkspaceBackup, parseWorkspaceBackup, prepareWorkspaceBackup, writeWorkspaceBackup, type WorkspaceBackupInventory } from './workspaceBackup'

type SavePicker = (options: {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>

function filePicker() {
  return (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker
}

export function formatMiB(bytes: number) {
  if (bytes === 0) return '0 B'
  return bytes < 1024 ** 2 ? new Intl.NumberFormat().format(bytes) + ' B' : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

function BackupInventory({ inventory, label }: { inventory: WorkspaceBackupInventory; label: string }) {
  const { projects, trashed, versions, recoveries, copied, bytes, links, absent, orphans, externalPages, unresolvedCanvases, smartlinks } = inventory
  return <section aria-label={label}>
    <p><strong>{projects} canvases, {trashed} explicitly trashed, {versions} saved versions and {recoveries} recoveries.</strong></p>
    <p>{copied.length} copied attachments ({formatMiB(bytes)}) include their file bytes. {orphans} asset records are unreferenced by the current heads and snapshots.</p>
    {links.length > 0 && <details><summary>{links.length} linked attachment{links.length === 1 ? ' requires' : 's require'} relinking</summary>
      <ul>{links.slice(0, 30).map(asset => <li key={asset.id}>{asset.name} ({formatMiB(asset.size)})</li>)}</ul>
      {links.length > 30 && <p>{links.length - 30} more links are recorded in the backup inventory.</p>}
    </details>}
    {absent.length > 0 && <details><summary>{absent.length} attachment{absent.length === 1 ? '' : 's'} already missing</summary>
      <ul>{absent.slice(0, 30).map(asset => <li key={asset.id}>{asset.name}</li>)}</ul>
      {absent.length > 30 && <p>{absent.length - 30} more missing attachments are recorded in the backup inventory.</p>}
    </details>}
    {externalPages > 0 && <p>{externalPages} references to Croft pages outside iCanvas include the reference only, across canvases and snapshots.</p>}
    {smartlinks > 0 && <p>{smartlinks} Smartlink references are included across current canvases and saved history. Provider permissions and remote media are not included; restores do not load links automatically.</p>}
    {unresolvedCanvases > 0 && <p>{unresolvedCanvases} canvas references have no current target. Their unavailable state is preserved.</p>}
  </section>
}

export function CanvasBackupDialog({ close, flush, canRestore, restore }: {
  close: () => void
  flush: () => Promise<void>
  canRestore: boolean
  restore?: (snapshot: WorkspaceStorageState) => Promise<void>
}) {
  const [workspaceInventory, setWorkspaceInventory] = useState<WorkspaceBackupInventory>()
  const [prepared, setPrepared] = useState<ReturnType<typeof prepareWorkspaceBackup>>()
  const [incoming, setIncoming] = useState<WorkspaceStorageState>()
  const [busy, setBusy] = useState<'reading' | 'backup' | 'verify' | 'restore'>('reading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState('')
  const savePicker = filePicker()
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController>(undefined)
  const readInitial = useRef({ flush, canRestore })
  const restoredInventory = incoming ? inspectWorkspaceBackup(incoming) : undefined

  useEffect(() => {
    let active = true
    const { canRestore: writer, flush: save } = readInitial.current
    void (writer ? save() : Promise.resolve()).then(getWorkspaceStorageState).then(state => {
      if (!active) return
      setWorkspaceInventory(inspectWorkspaceBackup(state))
      setPrepared(prepareWorkspaceBackup(state))
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (active) setBusy('reading') })
    return () => { active = false; operation.current?.abort() }
  }, [])

  function progressLabel(finished: number, total: number) {
    if (finished === total || finished % (4 * 1024 ** 2) === 0) setProgress(`${formatMiB(finished)} of ${formatMiB(total)}`)
  }

  function run(kind: 'backup' | 'verify' | 'restore', work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController()
    operation.current = controller
    setBusy(kind)
    setError('')
    setNotice('')
    setProgress('')
    void work(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted && !(reason instanceof DOMException && reason.name === 'AbortError'))
        setError(reason instanceof Error ? reason.message : String(reason))
      else setNotice('Cancelled.')
    }).finally(() => {
      if (operation.current === controller) operation.current = undefined
      setBusy('reading')
      setProgress('')
    })
  }

  async function save(signal: AbortSignal) {
    if (!savePicker || !prepared) return
    const handle = await savePicker.call(window, {
      suggestedName: `Croft-${new Date().toISOString().slice(0, 10)}.croftbackup`,
      types: [{ description: 'Croft workspace backup', accept: { 'application/octet-stream': ['.croftbackup'] } }],
    })
    signal.throwIfAborted()
    const writer = await handle.createWritable()
    try {
      await writeWorkspaceBackup(prepared, writer, { signal, progress: progressLabel })
      await writer.close()
    } catch (reason) {
      await writer.abort().catch(() => {})
      throw reason
    }
    setNotice('Workspace backup saved.')
  }

  return <CanvasDialog title="Backup and restore workspace" close={() => { if (busy === 'reading') close() }}>
    <div className="ic-form">
      <p>A workspace backup keeps iCanvas history and copied media together. This backup reflects the saved workspace when you opened the dialog. External file permissions and pages outside iCanvas are excluded.</p>
      {workspaceInventory ? <BackupInventory inventory={workspaceInventory} label="Workspace backup inventory" /> : !error && <p role="status">Reading saved workspace…</p>}
      {!canRestore && <p>This tab can back up the last saved state. Switch to the editing tab to restore.</p>}
      {!savePicker && <p>Saving a workspace backup requires a browser that supports streaming to a selected file. Open this workspace in a current Chromium browser that provides a save-file picker.</p>}
      <div className="ic-row">
        <button className="ic-button ic-primary" type="button" disabled={!prepared || !savePicker || busy !== 'reading'}
          onClick={() => run('backup', save)}>Save backup…</button>
        <button className="ic-button" type="button" disabled={!canRestore || busy !== 'reading'} onClick={() => input.current?.click()}>Choose backup to restore…</button>
        {(busy === 'backup' || busy === 'verify') && <button className="ic-button" type="button" onClick={() => operation.current?.abort()}>Cancel transfer</button>}
      </div>
      <input ref={input} type="file" hidden accept=".croftbackup" onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (!file || !canRestore) return
        setIncoming(undefined)
        run('verify', async signal => setIncoming(await parseWorkspaceBackup(file, { signal, progress: progressLabel })))
      }} />
      {incoming && restoredInventory && <section aria-label="Restore preview">
        <h3>Restore preview</h3>
        <BackupInventory inventory={restoredInventory} label="Verified backup inventory" />
        <p>Restore adds an independent copy of the backup. Existing canvases stay in this workspace.</p>
        <button className="ic-button ic-primary" type="button" disabled={!canRestore || busy !== 'reading'} onClick={() => run('restore', async () => {
          await flush()
          const copy = cloneWorkspaceBackup(incoming)
          if (restore) await restore(copy)
          else await restoreWorkspaceStorageState(copy, { merge: true })
          window.location.reload()
        })}>Restore as copies</button>
      </section>}
      {busy !== 'reading' && <p aria-live="polite" role="status">{busy === 'verify' ? 'Verifying backup…' : busy === 'restore' ? 'Restoring workspace…' : 'Writing backup…'} {progress}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </CanvasDialog>
}
