const lockName = 'croft-icanvas-writer'

type WriterAccess = { writable: true } | { writable: false; reason: string }
let ownsLock = false
let pending: Promise<WriterAccess> | undefined

export function requestWorkspaceWriter(): Promise<WriterAccess> {
  if (ownsLock) return Promise.resolve({ writable: true })
  if (pending) return pending
  if (!globalThis.navigator?.locks) {
    return Promise.resolve({
      writable: false,
      reason: 'This browser context has no Web Locks support. Open Croft in a supported browser to edit.',
    })
  }

  pending = new Promise<WriterAccess>(resolve => {
    try {
      void navigator.locks.request(lockName, { ifAvailable: true, mode: 'exclusive' }, async lock => {
        if (!lock) {
          resolve({
            writable: false,
            reason: 'Another Croft tab is editing. Close it, then enable editing here to load its latest saves.',
          })
          return
        }
        ownsLock = true
        resolve({ writable: true })
        // Keep the lease for this document's lifetime. Closing or terminating the tab releases it.
        await new Promise<never>(() => {})
      }).catch(() => resolve({
        writable: false,
        reason: 'Croft could not acquire the browser workspace lock. You can still view and export.',
      }))
    } catch {
      resolve({
        writable: false,
        reason: 'Croft could not access browser workspace locks. You can still view and export.',
      })
    }
  })
  const attempt = pending
  void attempt.finally(() => {
    if (pending === attempt) pending = undefined
  })
  return attempt
}

export function requireWorkspaceWriter() {
  if (!ownsLock) throw new Error('This tab has read-only access. Enable editing before saving.')
}
