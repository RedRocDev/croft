import type { CanvasAsset, CanvasProject } from './model.ts'

export type AudioAppearance = {
  mode: 'waveform' | 'compact'
  waveColour?: string
  progressColour?: string
  playheadColour?: string
}

export const defaultAudioAppearance: AudioAppearance = { mode: 'waveform' }

export function audioThemeColours(dark: boolean) {
  return dark
    ? { waveColour: '#979f9a', progressColour: '#94c9a8', playheadColour: '#f4fbf6' }
    : { waveColour: '#7c8e84', progressColour: '#3b6b54', playheadColour: '#234536' }
}

export function resolvedAudioAppearance(appearance: AudioAppearance | undefined, dark: boolean) {
  const defaults = audioThemeColours(dark)
  return { mode: appearance?.mode ?? defaultAudioAppearance.mode,
    waveColour: appearance?.waveColour ?? defaults.waveColour,
    progressColour: appearance?.progressColour ?? defaults.progressColour,
    playheadColour: appearance?.playheadColour ?? defaults.playheadColour }
}

export function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––'
  const time = Math.floor(seconds)
  const hours = Math.floor(time / 3600)
  const minutes = Math.floor((time % 3600) / 60)
  const remainder = String(time % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`
}

export function readAudioAppearance(value: unknown): AudioAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['mode', 'waveColour', 'progressColour', 'playheadColour'].includes(key))) {
    throw new Error('Invalid audio appearance.')
  }
  const settings = value as Record<string, unknown>
  const mode = settings.mode
  if (mode !== 'waveform' && mode !== 'compact') throw new Error('Unsupported audio display mode.')
  function colour(value: unknown) {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !/^#(?:[a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) throw new Error('Invalid audio waveform colour.')
    return value
  }
  const waveColour = colour(settings.waveColour)
  const progressColour = colour(settings.progressColour)
  const playheadColour = colour(settings.playheadColour)
  return { mode, ...(waveColour && { waveColour }), ...(progressColour && { progressColour }), ...(playheadColour && { playheadColour }) }
}

export function assertProjectAudioAppearance(project: CanvasProject) {
  for (const item of project.objects) {
    if (item.audioAppearance !== undefined) {
      if (!['audio', 'file'].includes(item.kind) || !item.assetId) throw new Error('Front audio appearance requires an audio attachment.')
      readAudioAppearance(item.audioAppearance)
    }
    if (item.back?.audioAppearance !== undefined) {
      if (!item.back.assetId) throw new Error('Back audio appearance requires an audio attachment.')
      readAudioAppearance(item.back.audioAppearance)
    }
  }
}

export function styledAudioAssetIds(projects: readonly CanvasProject[]) {
  const ids = new Set<string>()
  for (const project of projects) for (const item of project.objects) {
    if (item.audioAppearance && item.assetId) ids.add(item.assetId)
    if (item.back?.audioAppearance && item.back.assetId) ids.add(item.back.assetId)
  }
  return ids
}

export function assertStyledAudioAsset(asset: Pick<CanvasAsset, 'mime' | 'name' | 'blob' | 'handle'> | undefined) {
  if (!asset || !asset.blob && !asset.handle && asset.mime === 'application/octet-stream') return
  if (!asset.mime.startsWith('audio/')) throw new Error(`Audio appearance requires an audio source. “${asset.name}” has a different file type.`)
}
