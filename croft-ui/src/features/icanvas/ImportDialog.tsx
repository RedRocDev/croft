import { AlertTriangle, ChevronDown, ChevronRight, File, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CanvasAsset } from './model'
import './import.css'

export type CanvasFile = { file: File; handle?: FileSystemFileHandle }
export type CanvasPreparedAsset = CanvasAsset & { dimensions?: { width: number; height: number } }

export type CanvasImportMode = 'import' | 'link'
type NativePicker = (options: { multiple: boolean }) => Promise<FileSystemFileHandle[]>
type HandleItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

const fileLimit = 100 * 1024 * 1024
const batchLimit = 250 * 1024 * 1024
const executableNames = /\.(?:app|bat|cmd|com|cpl|dll|exe|hta|html?|jar|js|jse|lnk|msi|msp|pif|ps1|reg|scf|scr|svgz?|url|vb[es]?|ws[fh]|xhtml|xml)(?:\s|\.)*$/i
const permittedMedia = new Set([
  'audio/aac', 'audio/flac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav',
  'audio/webm', 'audio/x-wav', 'video/mp4', 'video/ogg', 'video/quicktime', 'video/webm',
])
const rasterTypes = new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])

export async function pickCanvasFiles(multiple = true): Promise<CanvasFile[] | undefined> {
  const native = (window as Window & { showOpenFilePicker?: NativePicker }).showOpenFilePicker
  if (!native) return undefined
  try {
    const handles = await native.call(window, { multiple })
    return await Promise.all(handles.map(async handle => ({ handle, file: await handle.getFile() })))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return []
    if (error instanceof DOMException && ['NotAllowedError', 'SecurityError', 'NotSupportedError'].includes(error.name)) return undefined
    throw error
  }
}

export async function droppedCanvasFiles(transfer: DataTransfer): Promise<CanvasFile[]> {
  const fallback = Array.from(transfer.files).map(file => ({ file }))
  const pending = Array.from(transfer.items).filter(item => item.kind === 'file').map(async (entry): Promise<CanvasFile | undefined> => {
    const file = entry.getAsFile()
    try {
      const handle = await (entry as HandleItem).getAsFileSystemHandle?.()
      if (handle?.kind === 'file') {
        const selected = handle as FileSystemFileHandle
        return { file: file ?? await selected.getFile(), handle: selected }
      }
    } catch {
      // Explorer drops may expose File objects but withhold persistent handles.
    }
    return file ? { file } : undefined
  })
  const files = (await Promise.all(pending)).filter((entry): entry is CanvasFile => !!entry)
  return files.length ? files : fallback
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`
  return `${(size / (1024 ** 2)).toFixed(1)} MiB`
}

function preliminaryWarning(file: File) {
  if (!file.name || executableNames.test(file.name)) return 'Executable, HTML, and SVG files cannot be added.'
  if (!file.size) return 'This file is empty.'
  if (file.size > fileLimit) return 'This file exceeds 100 MiB.'
  if (/html|javascript|ecmascript|svg|x-msdownload/i.test(file.type)) return 'This file type cannot be added.'
  return ''
}

export async function safeCanvasMime(file: File) {
  const warning = preliminaryWarning(file)
  if (warning) throw new Error(warning)
  const prefix = new Uint8Array(await file.slice(0, 2048).arrayBuffer())
  const text = new TextDecoder().decode(prefix).replace(/^\uFEFF/, '').trimStart()
  const ascii = (sign: string, start = 0) => sign.split('').every((character, offset) => prefix[start + offset] === character.charCodeAt(0))
  if (/^(?:<\?xml\b|<!doctype\s+html\b|<html\b|<head\b|<body\b|<svg\b|<script\b|#!)/i.test(text) || ascii('MZ')) {
    throw new Error('This file contains executable or active content.')
  }
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'image/jpeg'
  if (prefix[0] === 0x89 && ascii('PNG\r\n\x1a\n', 1)) return 'image/png'
  if (ascii('GIF87a') || ascii('GIF89a')) return 'image/gif'
  if (ascii('RIFF') && ascii('WEBP', 8)) return 'image/webp'
  if (ascii('BM')) return 'image/bmp'
  if (ascii('ftyp', 4) && (ascii('avif', 8) || ascii('avis', 8))) return 'image/avif'
  if (ascii('%PDF-')) return 'application/pdf'
  if (rasterTypes.has(file.type) || file.type === 'application/pdf') throw new Error('The file contents do not match the reported file type.')
  if (permittedMedia.has(file.type)) return file.type
  if (file.type === 'text/plain' || file.type === 'text/csv') return file.type
  return 'application/octet-stream'
}

export async function prepareCanvasAsset(entry: CanvasFile, mode: CanvasImportMode): Promise<CanvasPreparedAsset> {
  const { file, handle } = entry
  if (mode === 'link' && !handle) throw new Error('Choose a file with browser permission to Link In.')
  const mime = await safeCanvasMime(file)
  const asset: CanvasPreparedAsset = { id: crypto.randomUUID(), name: file.name, mime, size: file.size }
  const validated = file.slice(0, file.size, mime)
  if (rasterTypes.has(mime)) {
    try {
      const image = await createImageBitmap(validated)
      asset.dimensions = { width: image.width, height: image.height }
      image.close()
    } catch {
      throw new Error('This image could not be decoded.')
    }
  }
  return mode === 'link' ? { ...asset, handle, linked: true } : { ...asset, blob: validated }
}

export function ImportDialog({
  files, close, onImport, relink = false,
}: {
  files: CanvasFile[]
  close: () => void
  onImport: (assets: CanvasPreparedAsset[]) => Promise<void>
  relink?: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [modes, setModes] = useState<CanvasImportMode[]>(() => files.map(entry => relink && entry.handle ? 'link' : 'import'))
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState<string[]>([])
  const linked = modes.filter(mode => mode === 'link').length
  const eligible = files.filter(entry => !preliminaryWarning(entry.file))
  const allLinkable = eligible.length > 0 && eligible.every(entry => entry.handle)
  const canLinkAny = eligible.some(entry => entry.handle)
  const totalBytes = files.reduce((size, { file }, index) => size + (modes[index] === 'import' && !preliminaryWarning(file) ? file.size : 0), 0)
  const oversized = totalBytes > batchLimit
  const invalidReplacement = relink && files.length !== 1

  useEffect(() => {
    const node = dialog.current
    node?.showModal()
    return () => node?.close()
  }, [])

  function applyToAll(mode: CanvasImportMode) {
    setModes(files.map(entry => mode === 'link' && entry.handle ? 'link' : 'import'))
  }

  async function submit() {
    if (invalidReplacement || oversized || busy) return
    setBusy(true)
    setError('')
    const assets: CanvasPreparedAsset[] = []
    const failures: string[] = []
    try {
      for (const [index, entry] of files.entries()) {
        const file = entry.file
        setProgress(`Checking ${index + 1} of ${files.length}…`)
        try {
          assets.push(await prepareCanvasAsset(entry, modes[index]))
        } catch (reason) {
          failures.push(`${file.name}: ${reason instanceof Error ? reason.message : String(reason)}`)
        }
      }
      if (!assets.length) throw new Error('None of these files can be added.')
      setProgress(`Saving ${assets.length} ${assets.length === 1 ? 'file' : 'files'}…`)
      await onImport(assets)
      if (failures.length) setSkipped(failures)
      else close()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setSkipped(failures)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const finished = skipped.length > 0 && !error

  return <dialog ref={dialog} className="ic-dialog ic-import-dialog" aria-labelledby="ic-import-title" onCancel={event => {
    event.preventDefault()
    if (!busy) close()
  }}>
    <div className="ic-import-heading">
      <h2 id="ic-import-title">{relink ? 'Relink file' : 'Add files'}</h2>
      <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
      <button type="button" className="ic-import-toggle ic-button" aria-expanded={expanded} disabled={busy || finished} onClick={() => setExpanded(current => !current)}>
        {expanded ? <>Collapse <ChevronDown size={14} /></> : <>Expand <ChevronRight size={14} /></>}
      </button>
      <button type="button" aria-label={relink ? 'Close Relink file' : 'Close Add files'} className="ic-import-close" disabled={busy} onClick={close}><X size={17} /></button>
    </div>
    <div className="ic-import-settings">
      <div className="ic-import-selection"><span>Apply to all</span><div className="ic-import-segments" role="group" aria-label="Apply to all files">
        <button type="button" aria-pressed={linked === 0} disabled={busy || finished} onClick={() => applyToAll('import')}>Import</button>
        <button type="button" aria-pressed={linked === files.length && linked > 0} disabled={busy || finished || !canLinkAny} onClick={() => applyToAll('link')}>Link In</button>
      </div></div>
      {relink && <p className="ic-import-hint">{canLinkAny ? 'Link In keeps the file in its current location. Import stores a copy in Croft.' : 'The browser supplied a file copy. Import it into Croft or cancel to keep the existing link.'}</p>}
      {!relink && !allLinkable && <p className="ic-import-hint">{canLinkAny ? 'Files without a browser file handle will be imported.' : 'Link In needs a browser file handle. These files can be imported.'}</p>}
      {expanded && <ul className="ic-import-list">
        {files.map(({ file, handle }, index) => {
          const warning = preliminaryWarning(file)
          return <li key={index}>
            <File size={17} aria-hidden="true" />
            <div className="ic-import-info"><strong title={file.name}>{file.name}</strong><small>{warning || `${file.type || 'File'} · ${formatBytes(file.size)}`}</small></div>
            <div className="ic-import-segments" role="group" aria-label={`Add mode for ${file.name}`}>
              <button type="button" aria-pressed={modes[index] === 'import'} disabled={busy || finished || !!warning} onClick={() => setModes(previous => previous.map((mode, item) => item === index ? 'import' : mode))}>Import</button>
              <button type="button" aria-pressed={modes[index] === 'link'} disabled={busy || finished || !handle || !!warning} onClick={() => setModes(previous => previous.map((mode, item) => item === index ? 'link' : mode))}>Link In</button>
            </div>
          </li>
        })}
      </ul>}
      {oversized && <p role="alert" className="ic-import-error"><AlertTriangle size={15} /> Imported files must total no more than 250 MiB per batch.</p>}
      {invalidReplacement && <p role="alert" className="ic-import-error"><AlertTriangle size={15} /> Choose exactly one replacement file.</p>}
      {error && <p role="alert" className="ic-import-error"><AlertTriangle size={15} /> {error}</p>}
      {skipped.length > 0 && <ul className="ic-import-skipped" aria-label="Files skipped">{skipped.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
    </div>
    <div className="ic-import-footer">
      <span role="status">{progress || (finished ? `${skipped.length} ${skipped.length === 1 ? 'file skipped' : 'files skipped'}` : `${files.length - linked} Import · ${linked} Link In`)}</span>
      {!finished && <button type="button" className="ic-button" disabled={busy} onClick={close}>Cancel</button>}
      <button type="button" className="ic-button ic-import-primary" disabled={busy || (!finished && (oversized || invalidReplacement))} onClick={() => finished ? close() : void submit()}>{finished ? 'Done' : relink ? 'Relink' : 'Add'}</button>
    </div>
  </dialog>
}
