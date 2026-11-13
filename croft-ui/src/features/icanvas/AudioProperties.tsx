import { useId } from 'react'
import { ColourPicker } from './ColourPicker'
import { resolvedAudioAppearance, type AudioAppearance } from './audioAppearance'
import type { ProjectSwatch } from './model'

export function AudioProperties({ appearance, dark, disabled, swatches, change }: {
  appearance?: AudioAppearance
  dark: boolean
  disabled: boolean
  swatches?: readonly ProjectSwatch[]
  change: (appearance?: AudioAppearance) => void
}) {
  const label = useId()
  const { mode, waveColour, progressColour, playheadColour } = resolvedAudioAppearance(appearance, dark)
  return <fieldset className="ic-inspector-section ic-audio-properties" disabled={disabled}>
    <legend>Audio</legend>
    <label className="ic-inspector-field"><span>Audio display</span><select value={mode} onChange={event => {
      const value = event.currentTarget.value === 'compact' ? 'compact' : 'waveform'
      change({ ...appearance, mode: value })
    }}><option value="waveform">Waveform</option><option value="compact">Compact</option></select></label>
    <details open>
      <summary id={label}>Waveform</summary>
      <div className="ic-audio-colours" aria-labelledby={label}>
        <div role="group" aria-label="Waveform colour"><span>Waveform colour</span>
          <ColourPicker colour={waveColour} allowAlpha swatches={swatches} onChange={colour => change({ ...appearance, mode, waveColour: colour })} />
        </div>
        <div role="group" aria-label="Progress colour"><span>Progress colour</span>
          <ColourPicker colour={progressColour} allowAlpha swatches={swatches} onChange={colour => change({ ...appearance, mode, progressColour: colour })} />
        </div>
        <details><summary>Playhead</summary>
          <div role="group" aria-label="Playhead colour"><span>Playhead colour</span>
            <ColourPicker colour={playheadColour} allowAlpha swatches={swatches} onChange={colour => change({ ...appearance, mode, playheadColour: colour })} />
          </div>
        </details>
      </div>
    </details>
    <button type="button" className="ic-button" disabled={!appearance} onClick={() => change(undefined)}>Reset Appearance</button>
  </fieldset>
}
