import { useEffect, useRef, useState } from 'react'
import type { ImageEdits, ImageRect, ImageSize } from './imageEdits'
import { loadImage, renderEditedImage } from './imageRendering'
import './image-visual.css'

type EditedImageProps = {
  url: string
  alt: string
  edits?: ImageEdits
  compare?: boolean
  className?: string
  frame?: ImageSize
  maxSide?: number
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

export function EditedImage({ url, alt, edits, compare, className, frame, maxSide }: EditedImageProps) {
  const source = useImageSource(url)
  const wrapper = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const [measurement, setMeasurement] = useState<ImageSize>()
  const [renderError, setRenderError] = useState<{ url: string; message: string }>()
  const width = frame?.width ?? measurement?.width
  const height = frame?.height ?? measurement?.height

  useEffect(() => {
    const element = wrapper.current
    if (!element || frame) return
    const observer = new ResizeObserver(([next]) => {
      const { width, height } = next.contentRect
      if (width && height) setMeasurement(previous => previous?.width === width && previous.height === height ? previous : { width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame?.width, frame?.height])

  useEffect(() => {
    const element = layer.current
    if (!element || !source?.image || !width || !height) return
    const pending = requestAnimationFrame(() => {
      try {
        const current = compare ? undefined : edits
        const result = renderEditedImage(source.image!, current, { width, height, maxSide })
        const { canvas, insets } = result
        canvas.style.cssText = `left:${-insets.left}px;top:${-insets.top}px;width:${result.width}px;height:${result.height}px;`
        element.replaceChildren(canvas)
        setRenderError(undefined)
      } catch (error) {
        element.replaceChildren()
        setRenderError({ url, message: error instanceof Error ? error.message : 'The image could not be rendered.' })
      }
    })
    return () => cancelAnimationFrame(pending)
  }, [source, url, edits, compare, width, height, maxSide])

  const message = source?.error ?? (renderError?.url === url ? renderError.message : undefined)
  return <div ref={wrapper} className={['ic-edited-image', className].filter(Boolean).join(' ')}
    style={frame ? { width: frame.width, height: frame.height, flex: '0 0 auto' } : undefined}>
    <div key={url} ref={layer} className="ic-edited-image-paint" role="img" aria-label={alt} hidden={!source?.image || !!message} />
    {message && <span className="ic-edited-image-error" role="status">{message}</span>}
  </div>
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
