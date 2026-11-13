import { useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Link2, LoaderCircle, RotateCw, ShieldCheck } from 'lucide-react'
import { grantLoadOnce, hasLoadOnce, loadOnceKey, readExternalPermissions, setExternalPermission, subscribeExternalPermissions, type ExternalPermission } from './smartlinkPermissions'
import { providerLabel, type SmartlinkContent, type SmartlinkMode } from './smartlinks'
import './smartlinks.css'

type Provider = 'youtube' | 'x'
type ProviderFrameProps = { content: SmartlinkContent; dark: boolean; onStatus: (status: 'loaded' | 'error', message?: string) => void; retry: number }

function ProviderFrame({ content, dark, onStatus, retry }: ProviderFrameProps) {
  const frameId = useRef(`croft-${crypto.randomUUID()}`)
  const src = useMemo(() => {
    if (!content.contentId) return undefined
    if (content.provider === 'youtube') {
      const url = new URL(`https://www.youtube-nocookie.com/embed/${encodeURIComponent(content.contentId)}`)
      url.searchParams.set('playsinline', '1')
      url.searchParams.set('rel', '0')
      if (content.startSeconds) url.searchParams.set('start', String(content.startSeconds))
      return url.href
    }
    if (content.provider === 'x') {
      const url = new URL('https://platform.twitter.com/embed/Tweet.html')
      url.searchParams.set('id', content.contentId)
      url.searchParams.set('dnt', 'true')
      url.searchParams.set('lang', 'en')
      url.searchParams.set('theme', dark ? 'dark' : 'light')
      url.searchParams.set('origin', location.origin)
      url.searchParams.set('embedId', frameId.current)
      return url.href
    }
    return undefined
  }, [content.provider, content.contentId, content.startSeconds, dark, retry])

  if (!src) return null
  return <iframe key={`${retry}/${src}`} className="ic-smartlink-provider-frame"
    title={`${providerLabel(content.provider as Provider)} ${content.provider === 'youtube' ? 'video player' : 'post'}`}
    src={src} sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allow="fullscreen; encrypted-media; picture-in-picture"
    referrerPolicy="strict-origin-when-cross-origin" loading="eager"
    onLoad={() => onStatus('loaded')}
    onError={() => onStatus('error', `Could not load the official ${providerLabel(content.provider)} embed.`)} />
}

function hostLabel(content: SmartlinkContent) {
  try { return new URL(content.canonicalUrl).hostname.replace(/^www\./, '') } catch { return 'Website' }
}

export function SmartlinkView({ content, objectId, side, activeSlot, canPlay, canEdit, dark, onModeChange, onEdit, onPrivacy, zoomToPlay }: {
  content: SmartlinkContent; objectId: string; side: 'front' | 'back'; activeSlot: boolean; canPlay: boolean; canEdit: boolean; dark: boolean
  onModeChange: (mode: SmartlinkMode) => void; onEdit: () => void; onPrivacy: () => void; zoomToPlay: () => void
}) {
  const [permissions, setPermissions] = useState(readExternalPermissions)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'loaded' | 'error'>('idle')
  const [notice, setNotice] = useState('')
  const [keptAsLink, setKeptAsLink] = useState(false)
  const [retry, setRetry] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const [copyMessage, setCopyMessage] = useState('')
  const provider = content.provider === 'youtube' || content.provider === 'x' ? content.provider : undefined
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const grantKey = provider ? loadOnceKey(objectId, side, provider, content.canonicalUrl) : ''
  const preference: ExternalPermission = provider ? permissions[provider] : 'block'
  const approved = !!provider && (preference === 'allow' || hasLoadOnce(grantKey))
  const wantsEmbed = content.mode === 'embed' && !keptAsLink
  const denied = preference === 'block'
  const mounted = wantsEmbed && approved && activeSlot && canPlay && online && !denied && visible

  useEffect(() => subscribeExternalPermissions(() => setPermissions(readExternalPermissions())), [])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    const visibility = () => { setVisible(document.visibilityState === 'visible'); if (document.visibilityState !== 'visible') setStatus('idle') }
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => { setStatus('idle'); setNotice(''); setRetry(0); setKeptAsLink(false) }, [objectId, side, content.canonicalUrl, content.provider, content.mode])
  useEffect(() => {
    if (!mounted) return
    const timer = window.setTimeout(() => {
      setStatus(current => current === 'idle' || current === 'connecting' ? 'error' : current)
      setNotice(current => current || 'The provider did not confirm that this content is available.')
    }, 20_000)
    return () => window.clearTimeout(timer)
  }, [mounted, retry])

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(content.canonicalUrl); setCopyMessage('Link copied.') }
    catch { setCopyMessage('Clipboard access is unavailable. Select and copy the link below.') }
  }
  const requestOnce = () => {
    if (!provider) return
    grantLoadOnce(grantKey)
    setStatus('idle')
    setNotice('')
  }
  const alwaysAllow = () => {
    if (!provider) return
    try { setExternalPermission(provider, 'allow'); setPermissions(readExternalPermissions()) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save the privacy preference.') }
  }
  const retryEmbed = () => { setStatus('connecting'); setNotice(''); setRetry(value => value + 1) }

  if (content.mode === 'link' || keptAsLink) return <div className="ic-smartlink ic-smartlink-link" data-media-control>
    <span className="ic-smartlink-provider"><Link2 size={14} />{provider ? providerLabel(provider) : hostLabel(content)}</span>
    <strong>{content.title || (provider === 'youtube' ? 'YouTube video' : provider === 'x' ? 'X post' : hostLabel(content))}</strong>
    <a href={content.canonicalUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{content.canonicalUrl}</a>
    {content.notes && <p>{content.notes}</p>}
    <div className="ic-smartlink-actions"><button type="button" onClick={() => void copyLink()}>Copy Link</button><a href={content.canonicalUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Original <ExternalLink size={12} /></a>
      {canEdit && <button type="button" onClick={onEdit}>Edit Link</button>}</div>
    {copyMessage && <small role="status">{copyMessage}</small>}
  </div>

  if (content.mode === 'preview') return <div className="ic-smartlink ic-smartlink-preview" data-media-control>
    <span className="ic-smartlink-provider"><Link2 size={14} />{provider ? providerLabel(provider) : hostLabel(content)}</span>
    <strong>{content.title || (provider === 'youtube' ? 'YouTube video' : provider === 'x' ? 'X post' : hostLabel(content))}</strong>
    <a href={content.canonicalUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{content.canonicalUrl}</a>
    {content.notes && <p>{content.notes}</p>}
    <div className="ic-smartlink-actions"><button type="button" onClick={() => void copyLink()}>Copy Link</button><a href={content.canonicalUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Original <ExternalLink size={12} /></a>
      {canEdit && <button type="button" onClick={onEdit}>Edit Link</button>}</div>
    {copyMessage && <small role="status">{copyMessage}</small>}
  </div>

  const label = provider ? providerLabel(provider) : hostLabel(content)
  return <div className="ic-smartlink ic-smartlink-embed" data-media-control>
    {!provider && <><p>Live embeds are limited to YouTube and public X posts. This remains a local bookmark.</p><button type="button" onClick={() => onModeChange('preview')}>Use Preview Card</button></>}
    {provider && denied && <div className="ic-smartlink-message"><ShieldCheck size={16} /><span>{label} content is blocked in External Content privacy settings.</span><button type="button" onClick={onPrivacy}>Privacy Settings</button></div>}
    {provider && !approved && !denied && <div className="ic-smartlink-consent">
      <strong>Load content from {label}?</strong>
      <p>This connects to {label} and its delivery services to display this {provider === 'youtube' ? 'video' : 'post'}. Your project stays local, but the provider receives network information about this request.</p>
      <div className="ic-smartlink-actions"><button type="button" className="ic-smartlink-primary" onClick={requestOnce}>Load Once</button>
        <button type="button" onClick={alwaysAllow}>Always Allow {label}</button><button type="button" onClick={() => canEdit ? onModeChange('link') : setKeptAsLink(true)}>Keep as Link</button></div>
      <button type="button" className="ic-smartlink-privacy" onClick={onPrivacy}>External Content privacy settings</button>
    </div>}
    {provider && approved && !online && <div className="ic-smartlink-message"><span>Offline. The saved link and notes remain available.</span><button type="button" onClick={retryEmbed}>Retry</button></div>}
    {provider && approved && online && !canPlay && <div className="ic-smartlink-message"><span>Zoom in to play this {provider === 'youtube' ? 'video' : 'post'}.</span><button type="button" onClick={zoomToPlay}>Zoom to Play</button></div>}
    {provider && approved && online && canPlay && !activeSlot && <div className="ic-smartlink-message"><span>The live embed limit is in use. Loading this will release another inactive slot.</span><button type="button" onClick={retryEmbed}>Load Embed</button></div>}
    {provider && mounted && <>
      {(status === 'idle' || status === 'connecting') && <div className="ic-smartlink-status" role="status"><LoaderCircle size={13} />Connecting to {label}…</div>}
      {(status === 'loaded' || status === 'error') && <div className="ic-smartlink-status" role="status">{status === 'loaded' ? 'The provider frame loaded. This does not confirm the content is available or playable.' : notice || 'Could not confirm that this content is available.'}
        {status === 'error' && <button type="button" onClick={retryEmbed}><RotateCw size={12} />Retry</button>}</div>}
      <ProviderFrame content={content} dark={dark} retry={retry} onStatus={(next, message) => {
        if (next === 'error') { setStatus('error'); setNotice(message || 'The provider could not display this content.') }
        else setStatus('loaded')
      }} />
    </>}
    {provider && approved && online && canPlay && activeSlot && !mounted && !visible && <div className="ic-smartlink-message"><span>Live content paused while Croft is not visible.</span></div>}
    <div className="ic-smartlink-footer"><span>{content.title || `${label} · ${provider === 'youtube' ? 'Video' : provider === 'x' ? 'Post' : 'Bookmark'}`}</span>
      <button type="button" onClick={() => void copyLink()}>Copy Link</button>
      <a href={content.canonicalUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Original <ExternalLink size={12} /></a>
      {canEdit && <button type="button" onClick={onEdit}>Edit Link</button>}
    </div>
    {content.notes && <p className="ic-smartlink-notes">{content.notes}</p>}
    {copyMessage && <small role="status">{copyMessage}</small>}
  </div>
}

export function ExternalContentSettings() {
  const [permissions, setPermissions] = useState(readExternalPermissions)
  const [message, setMessage] = useState('')
  useEffect(() => subscribeExternalPermissions(() => setPermissions(readExternalPermissions())), [])
  const labels: { provider: Provider; label: string }[] = [{ provider: 'youtube', label: 'YouTube' }, { provider: 'x', label: 'X' }]
  return <section className="ic-external-settings">
    <p>Live Smartlinks send network requests to their provider only after you allow that provider. Croft stores project content locally. Permissions are separate from projects and are never included in exports or backups.</p>
    {labels.map(({ provider, label }) => <fieldset key={provider}>
      <legend>{label}</legend><p>Choose how Croft handles embedded {label} content.</p>
      <div className="ic-smartlink-permission-options">{(['ask', 'allow', 'block'] as const).map(value => <label key={value}>
        <input type="radio" name={`external-${provider}`} value={value} checked={permissions[provider] === value} onChange={() => {
          try { setExternalPermission(provider, value); setPermissions(readExternalPermissions()); setMessage(`${label} preference updated.`) }
          catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save privacy preference.') }
        }} />{value === 'ask' ? 'Ask before loading' : value === 'allow' ? `Always allow ${label}` : `Block ${label}`}
      </label>)}</div>
    </fieldset>)}
    <button type="button" onClick={() => {
      try { setExternalPermission('youtube', 'ask'); setExternalPermission('x', 'ask'); setPermissions(readExternalPermissions()); setMessage('Provider permissions reset to Ask.') }
      catch (error) { setMessage(error instanceof Error ? error.message : 'Could not reset preferences.') }
    }}>Reset provider permissions</button>
    <p>Blocking or returning to Ask tears down current embeds and clears one-time permissions. Requests already sent cannot be recalled, and Croft cannot remove provider cookies.</p>
    {message && <p role="status">{message}</p>}
  </section>
}
