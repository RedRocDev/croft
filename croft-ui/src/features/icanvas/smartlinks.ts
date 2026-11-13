export type SmartlinkProvider = 'youtube' | 'x' | 'website'
export type SmartlinkMode = 'embed' | 'preview' | 'link'
export type SmartlinkContent = {
  provider: SmartlinkProvider
  canonicalUrl: string
  contentId?: string
  startSeconds?: number
  mode: SmartlinkMode
  title?: string
  notes?: string
}

const maxUrlLength = 2048
const maxTitleLength = 512
const maxNotesLength = 16_384
const youtubeId = /^[A-Za-z0-9_-]{11}$/
const xPostId = /^[0-9]{1,30}$/

function boundedText(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error(`Smartlink ${field} is invalid or too long.`)
  return value
}

function isWebUrl(value: string) {
  if (!value || value.length > maxUrlLength || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return undefined
  return url
}

function parseSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  if (/^\d{1,8}$/.test(value)) return Math.min(Number(value), 86_400)
  const match = /^(?:(\d{1,3})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s?)?$/.exec(value)
  if (!match || !match.slice(1).some(Boolean)) return undefined
  const hours = Number(match[1] || 0), minutes = Number(match[2] || 0), seconds = Number(match[3] || 0)
  if (minutes > 59 || seconds > 59 && (match[1] || match[2])) return undefined
  return Math.min(86_400, hours * 3600 + minutes * 60 + seconds)
}

function website(url: URL): SmartlinkContent {
  return { provider: 'website', canonicalUrl: url.href, mode: 'preview' }
}

/** Parse locally. Unsupported provider routes become inert bookmarks; unsafe schemes are rejected. */
export function parseSmartlink(input: string): SmartlinkContent | undefined {
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input)) return undefined
  const text = input.trim()
  if (!text || text.length > maxUrlLength || /\s/.test(text)) return undefined
  const url = isWebUrl(text)
  if (!url) return undefined
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)

  const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])
  if (youtubeHosts.has(host)) {
    let ids: string[] = []
    if (host.endsWith('youtu.be')) ids = parts.length === 1 ? [parts[0]] : []
    else if (parts[0] === 'watch') ids = url.searchParams.getAll('v')
    else if (['shorts', 'live', 'embed'].includes(parts[0] ?? '') && parts.length === 2) ids = [parts[1]]
    if (ids.length === 1 && youtubeId.test(ids[0])) {
      const startParam = url.searchParams.get('start')
      const timeParam = url.searchParams.get('t')
      const start = startParam === null ? undefined : parseSeconds(startParam)
      const fromTime = timeParam === null ? undefined : parseSeconds(timeParam)
      if ((startParam !== null && start === undefined) || (timeParam !== null && fromTime === undefined) ||
          start !== undefined && fromTime !== undefined && start !== fromTime) return website(url)
      const startSeconds = start ?? fromTime
      const canonicalUrl = `https://www.youtube.com/watch?v=${ids[0]}${startSeconds ? `&t=${startSeconds}s` : ''}`
      return { provider: 'youtube', canonicalUrl, contentId: ids[0], mode: 'embed', ...(startSeconds ? { startSeconds } : {}) }
    }
    return website(url)
  }

  const xHosts = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'])
  if (xHosts.has(host)) {
    if (parts[0] === 'i' && parts[1] === 'web' && parts[2] === 'status' && parts.length === 4 && xPostId.test(parts[3]))
      return { provider: 'x', canonicalUrl: `https://x.com/i/status/${parts[3]}`, contentId: parts[3], mode: 'embed' }
    if (parts[0] === 'i' && parts[1] === 'status' && parts.length === 3 && xPostId.test(parts[2]))
      return { provider: 'x', canonicalUrl: `https://x.com/i/status/${parts[2]}`, contentId: parts[2], mode: 'embed' }
    if (parts.length >= 3 && parts[1] === 'status') {
      const postId = parts[2]
      const suffixOk = parts.length === 3 || (parts.length === 5 && ['photo', 'video'].includes(parts[3]) && parts[4] === '1')
      if (xPostId.test(postId) && suffixOk) return { provider: 'x', canonicalUrl: `https://x.com/i/status/${postId}`, contentId: postId, mode: 'embed' }
    }
    return website(url)
  }
  return website(url)
}

export function readSmartlink(value: unknown): SmartlinkContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Smartlink record.')
  const data = value as Record<string, unknown>
  const provider = data.provider
  const mode = data.mode
  if (!['youtube', 'x', 'website'].includes(String(provider)) || !['embed', 'preview', 'link'].includes(String(mode))) throw new Error('Invalid Smartlink provider or display mode.')
  if (provider === 'website' && mode === 'embed') throw new Error('Website bookmarks cannot use live embed mode.')
  if (typeof data.canonicalUrl !== 'string' || data.canonicalUrl.length > maxUrlLength) throw new Error('Invalid Smartlink URL.')
  const parsed = parseSmartlink(data.canonicalUrl)
  if (!parsed || parsed.provider !== provider || parsed.canonicalUrl !== data.canonicalUrl) throw new Error('Smartlink URL does not match its validated provider.')
  if (provider !== 'website' && (data.contentId !== parsed.contentId || data.startSeconds !== parsed.startSeconds)) throw new Error('Smartlink provider identity does not match its URL.')
  if (provider === 'website' && (data.contentId !== undefined || data.startSeconds !== undefined)) throw new Error('Bookmark records cannot include provider IDs.')
  if (data.startSeconds !== undefined && (!Number.isSafeInteger(data.startSeconds) || (data.startSeconds as number) < 0 || (data.startSeconds as number) > 86_400)) throw new Error('Invalid Smartlink start time.')
  const title = boundedText(data.title, maxTitleLength, 'title')
  const notes = boundedText(data.notes, maxNotesLength, 'notes')
  return { provider: provider as SmartlinkProvider, canonicalUrl: data.canonicalUrl, mode: mode as SmartlinkMode,
    ...(parsed.contentId ? { contentId: parsed.contentId } : {}), ...(parsed.startSeconds ? { startSeconds: parsed.startSeconds } : {}),
    ...(title !== undefined ? { title } : {}), ...(notes !== undefined ? { notes } : {}) }
}

export function providerLabel(provider: SmartlinkProvider) {
  return provider === 'youtube' ? 'YouTube' : provider === 'x' ? 'X' : 'Website'
}

export function smartlinkEmbedUrl(content: SmartlinkContent) {
  if (content.provider === 'youtube' && content.contentId) {
    const start = content.startSeconds ? `&start=${content.startSeconds}` : ''
    return `https://www.youtube-nocookie.com/embed/${content.contentId}?playsinline=1&rel=0${start}`
  }
  return undefined
}

export function smartlinkBounds(content: SmartlinkContent) {
  if (typeof content.canonicalUrl !== 'string' || content.canonicalUrl.length > maxUrlLength) throw new Error('Smartlink URL is invalid or too long.')
  if (content.provider === 'youtube' && (!content.contentId || !youtubeId.test(content.contentId))) throw new Error('Invalid YouTube video ID.')
  if (content.provider === 'x' && (!content.contentId || !xPostId.test(content.contentId))) throw new Error('Invalid X post ID.')
  boundedText(content.title, maxTitleLength, 'title')
  boundedText(content.notes, maxNotesLength, 'notes')
}
