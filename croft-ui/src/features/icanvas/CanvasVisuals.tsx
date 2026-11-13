import { useEffect, useRef, useState } from 'react'
import { AudioLines, FileText, Layers, Video } from 'lucide-react'
import { safeCanvasMime } from './ImportDialog'
import { canRequestFileRead, fileAccessProblem, readLinkedFile, requestFileRead, type FileAccessProblem } from './linkedFiles'
import { getAsset } from './storage'
import { cardFace, cardSide, objectFlags, type CanvasAsset, type CanvasObject, type CanvasProject } from './model'
import { rotatedBounds } from './geometry'
import { layoutStacks } from './stackScene'

type MediaResult = { url?: string; problem?: FileAccessProblem; handle?: FileSystemFileHandle; asset?: Pick<CanvasAsset, 'mime' | 'name'> }

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
        if (asset) next.asset = { mime: asset.mime, name: asset.name }
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
    asset: current?.asset,
    problem: current?.problem,
    requestProblem: requestResult?.id === assetId ? requestResult?.problem : undefined,
    requesting,
    restoreAccess: handle && canRequestFileRead(handle) ? restoreAccess : undefined,
    retry,
  }
}

export function CanvasThumbnail({ project }: { project: CanvasProject }) {
  const { url } = useAssetUrl(project.coverAssetId)
  if (url) return <img src={url} alt="" className="ic-cover" />
  const map = new Map(project.objects.map(object => [object.id, object]))
  const scene = layoutStacks(project.objects)
  const visible = project.objects.filter(object => object.kind !== 'group' && object.kind !== 'stack' &&
    !scene.obscured.has(object.id) && !objectFlags(object, map).hidden).slice(0, 60)
    .map(object => scene.cards.get(object.id) ?? object)
  if (!visible.length) return <div className="ic-thumbnail ic-thumbnail-empty" aria-hidden="true"><Layers size={18} /></div>
  const visibleIds = new Set(visible.map(object => object.id))
  const rear = [...scene.piles.values()].flatMap(pile => pile.frontId && visibleIds.has(pile.frontId) ? [...pile.rear].reverse() : [])
  const bounds = [...visible, ...rear.map(card => card.rect)].map(object =>
    rotatedBounds(object, object.rotation))
  const left = Math.min(...bounds.map(rect => rect.left)) - 24
  const top = Math.min(...bounds.map(rect => rect.top)) - 24
  const width = Math.max(...bounds.map(rect => rect.right)) - left + 24
  const height = Math.max(...bounds.map(rect => rect.bottom)) - top + 24
  return <svg className="ic-thumbnail" aria-hidden="true" viewBox={`${left} ${top} ${width} ${height}`}>
    {rear.map(({ memberId, rect, colour }) => <rect key={memberId} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={5}
      transform={`rotate(${rect.rotation} ${rect.x + rect.width / 2} ${rect.y + rect.height / 2})`}
      fill={colour} fillOpacity={.55} stroke="var(--muted)" strokeOpacity={.35} />)}
    {visible.map(object => {
      const side = cardSide(object)
      const back = side === 'back' ? cardFace(object, side) : undefined
      return <g key={object.id} transform={`rotate(${object.rotation} ${object.x + object.width / 2} ${object.y + object.height / 2})`}>
        <rect x={object.x} y={object.y} width={object.width} height={object.collapsed ? 35 : object.height}
          rx={5} fill={object.kind === 'text' && side === 'front' ? 'var(--muted)' : object.colour} fillOpacity={object.kind === 'frame' ? .25 : .75} />
        {back && <svg x={object.x} y={object.y} width={object.width} height={object.height} overflow="hidden">
          <text x={8} y={15} fill="#151d16" fontSize={9}>Back</text>
          <text x={8} y={32} fill="#151d16" fontSize={13}>{back.title || back.text.split('\n')[0] || (back.assetId ? 'Attachment' : '')}</text>
        </svg>}
      </g>
    })}
  </svg>
}

const fileMessages: Record<FileAccessProblem, string> = {
  prompt: 'File permission needed',
  denied: 'File access denied',
  missing: 'File missing or moved',
  changed: 'File changed since it was linked',
  unavailable: 'File unavailable',
}

function AssetAccess({ media, hasAsset, replace }: {
  media: ReturnType<typeof useAssetUrl>; hasAsset: boolean; replace?: () => void
}) {
  const { problem, requesting, requestProblem, restoreAccess, retry } = media
  const status = problem ?? 'unavailable'
  const canRestore = !!restoreAccess && (status === 'prompt' || status === 'denied')
  return <div className="ic-media-placeholder ic-file-access" data-media-control>
    <FileText size={16} />
    <span role="status">{fileMessages[requestProblem ?? status]}</span>
    <div>
      {canRestore ? <button type="button" disabled={requesting} onClick={() => void restoreAccess()}>
        {requesting ? 'Waiting for browser…' : 'Restore access'}
      </button> : hasAsset && status !== 'unavailable' && <button type="button" onClick={retry}>Check again</button>}
      {replace && <button type="button" disabled={requesting} onClick={replace}>Relink File</button>}
    </div>
  </div>
}

function pauseOnDetach(media: HTMLMediaElement | null) {
  if (media) return () => { media.pause() }
}

function BackAttachment({ assetId, replace }: { assetId: string; replace?: () => void }) {
  const media = useAssetUrl(assetId)
  if (media.problem) return <AssetAccess media={media} hasAsset replace={replace} />
  const { url, asset } = media
  if (!url || !asset) return <span role="status">Loading attachment…</span>
  if (asset.mime.startsWith('image/')) return <img src={url} alt={asset.name} draggable={false} />
  if (asset.mime.startsWith('audio/')) return <audio ref={pauseOnDetach} controls preload="metadata" src={url} aria-label={asset.name} />
  if (asset.mime.startsWith('video/')) return <video ref={pauseOnDetach} controls preload="none" src={url} aria-label={asset.name} />
  return <a className="ic-card-back-file" href={url} download={asset.name}><FileText size={14} />{asset.name}</a>
}

function CardBackFace({ object, replace }: { object: CanvasObject; replace?: () => void }) {
  const { title, text, assetId } = cardFace(object, 'back')
  const textStyle = { textAlign: object.textAlign }
  return <div className="ic-card-back" data-card-scroll>
    <span className="ic-card-back-marker">Back</span>
    {title && <p className="ic-card-back-title" style={textStyle} data-selectable-card-text>{title}</p>}
    {text && <p className="ic-card-back-text" style={textStyle} data-selectable-card-text>{text}</p>}
    {assetId && <div className="ic-card-back-asset" data-media-control>
      <BackAttachment assetId={assetId} replace={replace} />
    </div>}
    {!title && !text && !assetId && <p className="ic-card-back-empty">The back is empty.</p>}
  </div>
}

type ObjectContentProps = {
  object: CanvasObject; target?: CanvasProject; reloadMedia?: string; replace: () => void; canRelink?: boolean; replaceBack?: () => void
}

export function ObjectContent(props: ObjectContentProps) {
  return cardSide(props.object) === 'back'
    ? <CardBackFace object={props.object} replace={props.canRelink === false ? undefined : props.replaceBack} />
    : <FrontContent {...props} />
}

function FrontContent({ object, target, reloadMedia, replace, canRelink = true }: ObjectContentProps) {
  const media = useAssetUrl(reloadMedia)
  const { url, problem } = media
  const showsMedia = object.kind === 'audio' || object.kind === 'video' || object.kind === 'image' || object.kind === 'file'
  if (showsMedia && (problem || !reloadMedia)) return <AssetAccess media={media} hasAsset={!!reloadMedia} replace={canRelink ? replace : undefined} />
  switch (object.kind) {
    case 'image': return url ? <img className="ic-image" src={url} alt={object.name} draggable={false} /> : <div className="ic-media-placeholder">Loading image…</div>
    case 'audio': return url ? <audio ref={pauseOnDetach} controls preload="metadata" src={url} aria-label={object.name} /> : <div className="ic-media-placeholder"><AudioLines size={18} /> Audio</div>
    case 'video': return url ? <video ref={pauseOnDetach} controls preload="none" src={url} aria-label={object.name} /> : <div className="ic-media-placeholder"><Video size={18} /> Video</div>
    case 'file': return <div className="ic-media-placeholder"><FileText size={18} />{object.name}{url && <a href={url} download={object.name}>Download</a>}</div>
    case 'canvas': return target ? <><CanvasThumbnail project={target} /><div className="ic-object-title"><Layers size={14} />{target.name}</div></> : <div className="ic-media-placeholder">Canvas unavailable</div>
    case 'page': return <div className="ic-media-placeholder"><FileText size={20} />{object.name}<small>Croft page</small></div>
    case 'stroke': return <svg aria-hidden="true" viewBox={`0 0 ${object.width} ${object.height}`} preserveAspectRatio="none">
      <polyline points={object.points?.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={object.colour} strokeLinecap="round" strokeLinejoin="round" strokeWidth={object.strokeWidth ?? 3} />
    </svg>
    case 'frame': case 'group': case 'stack': case 'ellipse': case 'rectangle': return null
    case 'text': case 'note': return <div className="ic-object-text" style={{ textAlign: object.textAlign }}>{object.text || object.name}</div>
  }
}
