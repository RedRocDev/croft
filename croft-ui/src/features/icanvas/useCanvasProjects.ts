import { useCallback, useEffect, useRef, useState } from 'react'
import { seedProjects, type CanvasAsset, type CanvasProject } from './model'
import { getProjects, manualSave, saveProjects, saveRecovery } from './storage'

export function useCanvasProjects() {
  const [projects, setProjects] = useState<CanvasProject[]>([])
  const [status, setStatus] = useState<'Loading' | 'Unsaved' | 'Saving' | 'Saved' | 'Save failed'>('Loading')
  const [error, setError] = useState('')
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

  const load = useCallback(async () => {
    const saved = await getProjects()
    if (!saved.length) {
      saved.push(...seedProjects())
      await saveProjects(saved)
    }
    projectsRef.current = saved
    setProjects(saved)
    setStatus('Saved')
  }, [])

  useEffect(() => {
    void load().catch(reason => {
      setStatus('Save failed')
      setError(String(reason))
    })
  }, [load])

  const flush = useCallback(async (clearRecoveryFor?: string) => {
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
      setStatus(pending.current.size ? 'Unsaved' : 'Saved')
    } catch (reason) {
      setError(String(reason))
      setStatus('Save failed')
      throw reason
    } finally { activeWrites.current-- }
  }, [enqueue])

  useEffect(() => {
    const interval = setInterval(() => {
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
    const next = contentChanged ? { ...project, updatedAt: Date.now() } : project
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
    const starting = new Map(batch.map(project => [project.id, projectsRef.current.find(current => current.id === project.id)]))
    activeWrites.current++
    setStatus('Saving')
    try {
      await enqueue(async () => {
        await saveProjects(batch, assets)
        const next = new Map(projectsRef.current.map(project => [project.id, project]))
        for (const project of batch) {
          const initial = starting.get(project.id)
          const latest = next.get(project.id)
          if (initial && latest && initial !== latest) {
            const concurrentChanges = Object.fromEntries(Object.entries(latest).filter(([key, value]) =>
              initial[key as keyof CanvasProject] !== value))
            const merged = { ...project, ...concurrentChanges, updatedAt: Math.max(project.updatedAt, latest.updatedAt) }
            next.set(project.id, merged)
            pending.current.set(project.id, merged)
            recovery.current.set(project.id, merged)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => { void flush().catch(() => {}) }, 2_000)
          } else {
            next.set(project.id, project)
            pending.current.delete(project.id)
            if (recovery.current.has(project.id)) recovery.current.set(project.id, project)
          }
        }
        projectsRef.current = [...next.values()]
        setProjects(projectsRef.current)
      })
      setStatus(pending.current.size ? 'Unsaved' : 'Saved')
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
  return { projects, status, error, update, write, flush, refresh }
}
