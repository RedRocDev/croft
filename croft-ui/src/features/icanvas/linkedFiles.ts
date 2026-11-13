export type ReadPermission = 'granted' | 'prompt' | 'denied'

type ReadableHandle = FileSystemFileHandle & {
  queryPermission?: (options: { mode: 'read' }) => Promise<ReadPermission>
  requestPermission?: (options: { mode: 'read' }) => Promise<ReadPermission>
}

export function queryFileRead(handle: FileSystemFileHandle) {
  return (handle as ReadableHandle).queryPermission?.({ mode: 'read' })
}

export function requestFileRead(handle: FileSystemFileHandle) {
  return (handle as ReadableHandle).requestPermission?.({ mode: 'read' })
}

export function canRequestFileRead(handle: FileSystemFileHandle): boolean {
  return typeof (handle as ReadableHandle).requestPermission === 'function'
}

export type FileAccessProblem = 'prompt' | 'denied' | 'missing' | 'changed' | 'unavailable'

export function fileAccessProblem(error: unknown): FileAccessProblem {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'denied'
    if (error.name === 'NotFoundError') return 'missing'
  }
  return 'unavailable'
}

type LinkedFileMetadata = {
  name: string
  mime: string
  size: number
  handle: FileSystemFileHandle
}

export async function readLinkedFile(
  asset: LinkedFileMetadata,
  detectMime: (file: File) => Promise<string>,
): Promise<{ file: File } | { problem: FileAccessProblem }> {
  try {
    const permission = await queryFileRead(asset.handle)
    if (permission === 'prompt' || permission === 'denied') return { problem: permission }

    const file = await asset.handle.getFile()
    if (file.name !== asset.name || file.size !== asset.size) return { problem: 'changed' }
    try {
      if (await detectMime(file) !== asset.mime) return { problem: 'changed' }
    } catch (error) {
      return { problem: error instanceof DOMException ? fileAccessProblem(error) : 'changed' }
    }
    return { file }
  } catch (error) {
    return { problem: fileAccessProblem(error) }
  }
}
