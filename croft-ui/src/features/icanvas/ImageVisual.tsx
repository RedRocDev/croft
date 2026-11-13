import { useEffect, useRef, useState } from 'react'
import { imageEffectInsets, type ImageEdits, type ImageRect, type ImageSize } from './imageEdits'
import { createImagePreview } from './imagePreview'
import { loadImage, renderEditedImage } from './imageRendering'
import './image-visual.css'

type EditedImageProps = {
  url: string
  alt: string
  edits?: ImageEdits
  compare?: boolean
  frame: ImageSize
  previewScale: number
}

function useImageSource(url: string) {
  const [source, setSource] = useState<{ url: string; image?: HTMLImageElement; error?: string }>()
  useEffect(() => {
    let current = true
    void loadImage(url).then(image => {
      if (current) setSource({ url, image })
    }, (error: Error) => {
      if (current) setSource({ url, error: error.message })
    })
    return () => { current = false }
  }, [url])
  return source?.url === url ? source : undefined
}

export function EditedImage({ url, alt, edits, compare, frame, previewScale }: EditedImageProps) {
  return <ImagePreview key={url} {...{ url, alt, edits, compare, frame, previewScale }} />
}

function ImagePreview({ url, alt, edits, compare, frame, previewScale }: EditedImageProps) {
  const source = useImageSource(url)
  const layer = useRef<HTMLDivElement>(null)
  const preview = useRef<ReturnType<typeof createImagePreview> | undefined>(undefined)
  const scale = useRef(previewScale)
  scale.current = previewScale
  const [renderError, setRenderError] = useState<string>()
  const { width, height } = frame
  const current = compare ? undefined : edits

  useEffect(() => {
    const element = layer.current
    if (!element) return
    const slot = createImagePreview(() => clearCanvas(element))
    preview.current = slot
    return () => { slot.dispose(); preview.current = undefined }
  }, [])

  useEffect(() => {
    const element = layer.current
    const image = source?.image
    if (!element || !image || !width || !height) return
    const { left, right, top, bottom } = imageEffectInsets(current)
    preview.current?.request({ width: width + left + right, height: height + top + bottom, scale: scale.current, paint: raster => {
      try {
        const result = renderEditedImage(image, current, { width, height, preview: raster })
        const { canvas, insets } = result
        canvas.style.cssText = `left:${-insets.left}px;top:${-insets.top}px;width:${result.width}px;height:${result.height}px;`
        clearCanvas(element)
        element.replaceChildren(canvas)
        setRenderError(undefined)
        return true
      } catch (error) {
        clearCanvas(element)
        setRenderError(error instanceof Error ? error.message : 'The image could not be rendered.')
        return false
      }
    } })
  }, [source, current, width, height])

  useEffect(() => { preview.current?.resize(previewScale) }, [previewScale])

  const message = source?.error ?? renderError
  return <div className="ic-edited-image" style={{ width, height, flex: '0 0 auto' }}>
    <div ref={layer} className="ic-edited-image-paint" role="img" aria-label={alt} hidden={!source?.image || !!message} />
    {message && <span className="ic-edited-image-error" role="status">{message}</span>}
  </div>
}

function clearCanvas(layer: HTMLDivElement) {
  const canvas = layer.firstElementChild
  if (canvas instanceof HTMLCanvasElement) canvas.width = canvas.height = 0
  layer.replaceChildren()
}

export function EditedImageThumbnail({ url, edits, frame }: { url: string; edits?: ImageEdits; frame: ImageRect }) {
  const source = useImageSource(url)
  const [output, setOutput] = useState<{ url: string; picture: string; width: number; height: number; x: number; y: number }>()
  useEffect(() => {
    if (!source?.image) return
    const pending = requestAnimationFrame(() => {
      try {
        const result = renderEditedImage(source.image!, edits, { width: frame.width, height: frame.height, maxSide: 128 })
        setOutput({ url, picture: result.canvas.toDataURL(), width: result.width, height: result.height,
          x: frame.x - result.insets.left, y: frame.y - result.insets.top })
      } catch { setOutput(undefined) }
    })
    return () => cancelAnimationFrame(pending)
  }, [source, edits, url, frame.x, frame.y, frame.width, frame.height])
  if (output?.url !== url) return null
  return <image href={output.picture} x={output.x} y={output.y} width={output.width} height={output.height} preserveAspectRatio="none" />
}
