import { useEffect, useState } from 'react'
import { AudioLines, FileText, Layers, Video } from 'lucide-react'
import { getAsset } from './storage'
import { objectFlags, type CanvasObject, type CanvasProject } from './model'

export function useAssetUrl(assetId?: string) {
  const [result, setResult] = useState<{ id: string; url?: string; missing?: boolean }>({ id: '' })
  useEffect(() => {
    if (!assetId) return
    let active = true
    let url: string | undefined
    void getAsset(assetId).then(async asset => {
      const file = asset?.blob ?? await asset?.handle?.getFile()
      if (!active) return
      const matches = file && asset && file.size === asset.size &&
        (asset.blob || ((!file.type || file.type === asset.mime) && file instanceof File && file.name === asset.name))
      url = matches && file ? URL.createObjectURL(new Blob([file], { type: asset.mime })) : undefined
      setResult({ id: assetId, url, missing: !url })
    }).catch(() => {
      if (active) setResult({ id: assetId, missing: true })
    })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [assetId])
  return result.id === assetId ? result : { url: undefined, missing: false }
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

export function ObjectContent({ object, target, reloadMedia, replace }: {
  object: CanvasObject; target?: CanvasProject; reloadMedia?: string; replace: () => void
}) {
  const { url, missing } = useAssetUrl(reloadMedia)
  const media = object.kind === 'audio' || object.kind === 'video' || object.kind === 'image' || object.kind === 'file'
  if (media && missing) return <div className="ic-media-placeholder"><FileText size={16} /><span>File unavailable</span><button onClick={replace}>Relink File</button></div>
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
