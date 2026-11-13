import type { SmartlinkProvider } from './smartlinks.ts'

export type ExternalPermission = 'ask' | 'allow' | 'block'
export type ExternalPermissions = { youtube: ExternalPermission; x: ExternalPermission }
const storageKey = 'croft.external-content.v1'
const channelName = 'croft.external-content.v1'
const defaultPermissions: ExternalPermissions = { youtube: 'ask', x: 'ask' }
const grants = new Set<string>()
let channel: BroadcastChannel | undefined

function valid(value: unknown): value is ExternalPermissions {
  if (!value || typeof value !== 'object') return false
  const data = value as Record<string, unknown>
  return ['ask', 'allow', 'block'].includes(String(data.youtube)) && ['ask', 'allow', 'block'].includes(String(data.x))
}

export function readExternalPermissions(): ExternalPermissions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || 'null')
    return valid(value) ? { youtube: value.youtube, x: value.x } : { ...defaultPermissions }
  } catch { return { ...defaultPermissions } }
}

function notify() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('croft-external-content-change'))
  try { (channel ??= new BroadcastChannel(channelName)).postMessage({ type: 'refresh' }) } catch { /* storage events still notify other tabs */ }
}

export function setExternalPermission(provider: 'youtube' | 'x', permission: ExternalPermission) {
  const next = { ...readExternalPermissions(), [provider]: permission }
  try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { throw new Error('Croft could not save this privacy preference in browser storage.') }
  if (permission !== 'allow') clearLoadOnce(provider)
  notify()
}

export function loadOnceKey(objectId: string, side: 'front' | 'back', provider: SmartlinkProvider, url: string) {
  return `${objectId}\u0000${side}\u0000${provider}\u0000${url}`
}

export function hasLoadOnce(key: string) { return grants.has(key) }
export function grantLoadOnce(key: string) { grants.add(key); notify() }
export function clearLoadOnce(provider?: 'youtube' | 'x') {
  if (!provider) grants.clear()
  else for (const key of grants) if (key.includes(`\u0000${provider}\u0000`)) grants.delete(key)
  notify()
}

export function subscribeExternalPermissions(callback: () => void) {
  const onChange = () => callback()
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return
    if (!event.newValue) clearLoadOnce()
    else {
      let previous: ExternalPermissions = defaultPermissions
      let next: ExternalPermissions = defaultPermissions
      try {
        const oldValue: unknown = JSON.parse(event.oldValue || 'null')
        const newValue: unknown = JSON.parse(event.newValue)
        if (valid(oldValue)) previous = oldValue
        if (valid(newValue)) next = newValue
      } catch { /* malformed preference resets to Ask */ }
      for (const provider of ['youtube', 'x'] as const) if (previous[provider] !== next[provider] && next[provider] !== 'allow') clearLoadOnce(provider)
    }
    callback()
  }
  const onMessage = (event: MessageEvent) => { if (event.data?.type === 'refresh') callback() }
  window.addEventListener('croft-external-content-change', onChange)
  window.addEventListener('storage', onStorage)
  try { (channel ??= new BroadcastChannel(channelName)).addEventListener('message', onMessage) } catch { /* optional cross-tab notification */ }
  return () => {
    window.removeEventListener('croft-external-content-change', onChange)
    window.removeEventListener('storage', onStorage)
    channel?.removeEventListener('message', onMessage)
  }
}
