import { useEffect, useRef, useState } from 'react'
import { AudioLines, FileText, Layers, Video } from 'lucide-react'
import { safeCanvasMime } from './ImportDialog'
import { canRequestFileRead, fileAccessProblem, readLinkedFile, requestFileRead, type FileAccessProblem } from './linkedFiles'
import { getAsset } from './storage'
import { objectFlags, type CanvasObject, type CanvasProject } from './model'

type MediaResult = { url?: string; problem?: FileAccessProblem; handle?: FileSystemFileHandle }

export function useAssetUrl(assetId?: string) {
  const [result, setResult] = useState<{ id: string } & MediaResult>()
  const [refresh, setRefresh] = useState(0)
  const [requesting, setRequesting] = useState(false)
  const [requestResult, setRequestResult] = useState<{ id: string; problem: FileAccessProblem }>()
  const currentId = useRef(assetId)
  currentId.current = assetId

  useEffect(() => {
    if (!assetId) return
    const id = assetId
    let active = true
    let requestVersion = 0
    let url: string | undefined
    let listening = false
    let previousModified: number | undefined

    async function observe() {
      const version = ++requestVersion
      let next: MediaResult
      let blob: Blob | undefined
      let modified: number | undefined
      try {
        const asset = await getAsset(id)
        if (!active || version !== requestVersion) return
        if (!listening && !asset?.blob && asset?.handle) {
          listening = true
          window.addEventListener('focus', onFocus)
          document.addEventListener('visibilitychange', onVisible)
        }
        if (!asset) next = { problem: 'missing' }
        else if (asset.blob) {
          next = asset.blob.size === asset.size ? {} : { problem: 'unavailable' }
          if (!next.problem) blob = asset.blob.slice(0, asset.blob.size, asset.mime)
        } else if (asset.handle) {
          const outcome = await readLinkedFile({ ...asset, handle: asset.handle }, safeCanvasMime)
          next = { handle: asset.handle }
          if ('file' in outcome) {
            blob = outcome.file.slice(0, outcome.file.size, asset.mime)
            modified = outcome.file.lastModified
          } else next.problem = outcome.problem
        } else next = { problem: 'unavailable' }
      } catch (error) {
        next = { problem: fileAccessProblem(error) }
      }
      if (!active || version !== requestVersion) return
      if (!blob || !url || modified !== previousModified) {
        if (url) URL.revokeObjectURL(url)
        url = blob && URL.createObjectURL(blob)
      }
      previousModified = modified
      setResult({ id, ...next, url })
    }

    const onFocus = () => { void observe() }
    const onVisible = () => { if (document.visibilityState === 'visible') onFocus() }
    void observe()
    return () => {
      active = false
      if (listening) {
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('visibilitychange', onVisible)
      }
      if (url) URL.revokeObjectURL(url)
    }
  }, [assetId, refresh])

  const current = result?.id === assetId ? result : undefined
  const handle = current?.handle
  function retry() {
    setRequestResult(undefined)
    setRefresh(value => value + 1)
  }
  async function restoreAccess() {
    if (!assetId || !handle || requesting) return
    setRequestResult(undefined)
    setRequesting(true)
    try {
      const permission = await requestFileRead(handle)
      if (currentId.current !== assetId) return
      if (permission === 'granted') retry()
      else setRequestResult({ id: assetId, problem: permission ?? 'unavailable' })
    } catch (error) {
      if (currentId.current === assetId) setRequestResult({ id: assetId, problem: fileAccessProblem(error) })
    } finally {
      setRequesting(false)
    }
  }
  return {
    url: current?.url,
    problem: current?.problem,
    requestProblem: requestResult?.id === assetId ? requestResult?.problem : undefined,
    requesting,
    restoreAccess: handle && canRequestFileRead(handle) ? restoreAccess : undefined,
    retry,
  }
}

export function CanvasThumbnail({ project }: { project: CanvasProject }) {
  const { url } = useAssetUrl(project.coverAssetId)
  const map = new Map(project.objects.map(object => [object.id, object]))
  const visible = project.objects.filter(object => object.kind !== 'group' && !objectFlags(object, map).hidden).slice(0, 60)
  if (url) return <img src={url} alt="" className="ic-cover" />
  if (!visible.length) return <div className="ic-thumbnail ic-thumbnail-empty" aria-hidden="true"><Layers size={18} /></div>
  const left = Math.min(...visible.map(object => object.x)) - 24
  const top = Math.min(...visible.map(object => object.y)) - 24
  const width = Math.max(...visible.map(object => object.x + object.width)) - left + 24
  const height = Math.max(...visible.map(object => object.y + object.height)) - top + 24
  return <svg className="ic-thumbnail" aria-hidden="true" viewBox={`${left} ${top} ${width} ${height}`}>
    {visible.map(object => <rect key={object.id} x={object.x} y={object.y} width={object.width} height={object.collapsed ? 35 : object.height}
      rx={5} fill={object.kind === 'text' ? 'var(--muted)' : object.colour} fillOpacity={object.kind === 'frame' ? .25 : .75} />)}
  </svg>
}

const fileMessages: Record<FileAccessProblem, string> = {
  prompt: 'File permission needed',
  denied: 'File access denied',
  missing: 'File missing or moved',
  changed: 'File changed since it was linked',
  unavailable: 'File unavailable',
}

export function ObjectContent({ object, target, reloadMedia, replace, canRelink = true }: {
  object: CanvasObject; target?: CanvasProject; reloadMedia?: string; replace: () => void; canRelink?: boolean
}) {
  const { url, problem, requesting, requestProblem, restoreAccess, retry } = useAssetUrl(reloadMedia)
  const media = object.kind === 'audio' || object.kind === 'video' || object.kind === 'image' || object.kind === 'file'
  if (media && (problem || !reloadMedia)) {
    const status = problem ?? 'unavailable'
    const canRestore = !!restoreAccess && (status === 'prompt' || status === 'denied')
    return <div className="ic-media-placeholder ic-file-access" data-media-control>
      <FileText size={16} />
      <span role="status">{fileMessages[requestProblem ?? status]}</span>
      <div>
        {canRestore ? <button type="button" disabled={requesting} onClick={() => void restoreAccess()}>
          {requesting ? 'Waiting for browser…' : 'Restore access'}
        </button> : reloadMedia && status !== 'unavailable' && <button type="button" onClick={retry}>Check again</button>}
        {canRelink && <button type="button" disabled={requesting} onClick={replace}>Relink File</button>}
      </div>
    </div>
  }
  switch (object.kind) {
    case 'image': return url ? <img className="ic-image" src={url} alt={object.name} draggable={false} /> : <div className="ic-media-placeholder">Loading image…</div>
    case 'audio': return url ? <audio controls preload="metadata" src={url} aria-label={object.name} /> : <div className="ic-media-placeholder"><AudioLines size={18} /> Audio</div>
    case 'video': return url ? <video controls preload="none" src={url} aria-label={object.name} /> : <div className="ic-media-placeholder"><Video size={18} /> Video</div>
    case 'file': return <div className="ic-media-placeholder"><FileText size={18} />{object.name}{url && <a href={url} download={object.name}>Download</a>}</div>
    case 'canvas': return target ? <><CanvasThumbnail project={target} /><div className="ic-object-title"><Layers size={14} />{target.name}</div></> : <div className="ic-media-placeholder">Canvas unavailable</div>
    case 'page': return <div className="ic-media-placeholder"><FileText size={20} />{object.name}<small>Croft page</small></div>
    case 'stroke': return <svg aria-hidden="true" viewBox={`0 0 ${object.width} ${object.height}`} preserveAspectRatio="none">
      <polyline points={object.points?.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={object.colour} strokeLinecap="round" strokeLinejoin="round" strokeWidth={object.strokeWidth ?? 3} />
    </svg>
    case 'frame': case 'group': case 'ellipse': case 'rectangle': return null
    case 'text': case 'note': return <div className="ic-object-text">{object.text || object.name}</div>
  }
}
