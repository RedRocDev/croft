import { useCallback, useEffect, useRef, useState } from 'react'
import { seedProjects, type CanvasAsset, type CanvasProject } from './model'
import { getProjects, manualSave, saveProjects, saveRecovery } from './storage'
import { requestWorkspaceWriter, requireWorkspaceWriter } from './writerLock.ts'

type WorkspaceAccess = 'opening' | 'writer' | 'readonly'

export function useCanvasProjects() {
  const [projects, setProjects] = useState<CanvasProject[]>([])
  const [status, setStatus] = useState<'Loading' | 'Unsaved' | 'Saving' | 'Saved' | 'Save failed'>('Loading')
  const [error, setError] = useState('')
  const [access, setAccess] = useState<WorkspaceAccess>('opening')
  const [accessReason, setAccessReason] = useState('')
  const accessRef = useRef<WorkspaceAccess>('opening')
  const opening = useRef<Promise<void> | undefined>(undefined)
  const projectsRef = useRef(projects)
  const pending = useRef(new Map<string, CanvasProject>())
  const recovery = useRef(new Map<string, CanvasProject>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const activeWrites = useRef(0)

  const enqueue = useCallback((operation: () => Promise<void>) => {
    const next = queue.current.then(operation)
    queue.current = next.catch(() => {})
    return next
  }, [])

  const requestEditing = useCallback(() => {
    if (accessRef.current === 'writer') return Promise.resolve()
    if (opening.current) return opening.current
    setAccess('opening')
    setStatus('Loading')
    setError('')
    setAccessReason('')
    const attempt = enqueue(async () => {
      const lease = await requestWorkspaceWriter()
      const saved = await getProjects()
      if (lease.writable && !saved.length) {
        saved.push(...seedProjects())
        await saveProjects(saved)
      }
      // A formerly read-only tab must use the committed head from the prior writer.
      projectsRef.current = saved
      setProjects(saved)
      accessRef.current = lease.writable ? 'writer' : 'readonly'
      setAccess(accessRef.current)
      if (!lease.writable) setAccessReason(lease.reason)
      setStatus('Saved')
    }).catch(reason => {
      accessRef.current = 'readonly'
      setAccess('readonly')
      setError(String(reason))
      setStatus('Save failed')
      setAccessReason('Croft could not read this workspace. Retry to reopen it.')
    }).finally(() => { opening.current = undefined })
    opening.current = attempt
    return attempt
  }, [enqueue])

  useEffect(() => {
    void requestEditing()
  }, [requestEditing])

  const flush = useCallback(async (clearRecoveryFor?: string) => {
    requireWorkspaceWriter()
    if (accessRef.current !== 'writer') throw new Error('Enable editing before saving.')
    clearTimeout(timer.current)
    activeWrites.current++
    setStatus('Saving')
    try {
      await enqueue(async () => {
        const batch = [...pending.current.values()]
        if (clearRecoveryFor) {
          const current = projectsRef.current.find(project => project.id === clearRecoveryFor)
          if (!current) throw new Error('Canvas is unavailable.')
          await manualSave(batch.some(project => project.id === current.id) ? batch : [...batch, current], current.id)
          if (!pending.current.has(current.id) || pending.current.get(current.id) === current) recovery.current.delete(current.id)
        } else if (batch.length) {
          await saveProjects(batch)
        }
        for (const project of batch) if (pending.current.get(project.id) === project) pending.current.delete(project.id)
      })
      setError('')
      setStatus(activeWrites.current > 1 ? 'Saving' : pending.current.size ? 'Unsaved' : 'Saved')
    } catch (reason) {
      setError(String(reason))
      setStatus('Save failed')
      throw reason
    } finally { activeWrites.current-- }
  }, [enqueue])

  useEffect(() => {
    const interval = setInterval(() => {
      if (accessRef.current !== 'writer') return
      const batch = [...recovery.current.values()]
      if (!batch.length) return
      void enqueue(async () => {
        for (const project of batch) {
          if (recovery.current.get(project.id) !== project) continue
          await saveRecovery(project)
          if (recovery.current.get(project.id) === project) recovery.current.delete(project.id)
        }
      }).catch(reason => setError('Recovery checkpoint failed. ' + String(reason)))
    }, 300_000)
    const check = (event: BeforeUnloadEvent) => {
      if (pending.current.size || activeWrites.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    addEventListener('beforeunload', check)
    return () => {
      removeEventListener('beforeunload', check)
      clearInterval(interval)
      clearTimeout(timer.current)
    }
  }, [enqueue])

  function update(project: CanvasProject, contentChanged = true) {
    if (accessRef.current !== 'writer') return
    const prior = projectsRef.current.find(current => current.id === project.id)
    if (!prior) return
    const next = contentChanged ? { ...project, updatedAt: Math.max(Date.now(), prior.updatedAt + 1) } : project
    const list = projectsRef.current.map(current => current.id === next.id ? next : current)
    projectsRef.current = list
    setProjects(list)
    pending.current.set(next.id, next)
    if (contentChanged || recovery.current.has(next.id)) recovery.current.set(next.id, next)
    setStatus('Unsaved')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void flush().catch(() => {}) }, 2_000)
  }

  async function write(batch: CanvasProject[], assets?: CanvasAsset[]) {
    requireWorkspaceWriter()
    if (accessRef.current !== 'writer') throw new Error('Enable editing before saving.')
    const starting = new Map(batch.map(project => [project.id, projectsRef.current.find(current => current.id === project.id)]))
    const staged = batch.map(project => {
      const current = starting.get(project.id)
      return current ? { ...project, updatedAt: Math.max(project.updatedAt, current.updatedAt + 1, Date.now()) } : project
    })
    activeWrites.current++
    setStatus('Saving')
    try {
      await enqueue(async () => {
        await saveProjects(staged, assets)
        const next = new Map(projectsRef.current.map(project => [project.id, project]))
        for (const project of staged) {
          const initial = starting.get(project.id)
          const latest = next.get(project.id)
          if (initial && latest && initial !== latest) {
            const concurrentChanges = Object.fromEntries(Object.entries(latest).filter(([key, value]) =>
              initial[key as keyof CanvasProject] !== value))
            const merged = { ...project, ...concurrentChanges, updatedAt: Math.max(project.updatedAt + 1, latest.updatedAt) }
            next.set(project.id, merged)
            pending.current.set(project.id, merged)
            recovery.current.set(project.id, merged)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => { void flush().catch(() => {}) }, 2_000)
          } else {
            next.set(project.id, project)
            pending.current.delete(project.id)
            recovery.current.set(project.id, project)
          }
        }
        projectsRef.current = [...next.values()]
        setProjects(projectsRef.current)
      })
      setStatus(activeWrites.current > 1 ? 'Saving' : pending.current.size ? 'Unsaved' : 'Saved')
      setError('')
    } catch (reason) {
      setStatus('Save failed')
      setError(String(reason))
      throw reason
    } finally { activeWrites.current-- }
  }

  async function refresh() {
    await enqueue(async () => {
      const next = await getProjects()
      projectsRef.current = next.map(project => pending.current.get(project.id) ?? project)
      setProjects(projectsRef.current)
    })
  }
  return { projects, status, error, access, accessReason, requestEditing, update, write, flush, refresh }
}
