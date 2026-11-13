import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { formatAudioTime, readAudioAppearance, resolvedAudioAppearance } from '../src/features/icanvas/audioAppearance.ts'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'
import { importProject, makeProjectPackage, renderProjectSvg } from '../src/features/icanvas/portability.ts'
import { cloneProjectTree } from '../src/features/icanvas/storage.ts'
import { cloneWorkspaceBackup, parseWorkspaceBackup, streamWorkspaceBackup } from '../src/features/icanvas/workspaceBackup.ts'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const decode = new TextDecoder()
const readBlob = async blob => new Uint8Array(await blob.arrayBuffer())

function fixture() {
  const source = { id: 'synthetic-wave', name: 'Chime.wav', mime: 'audio/wav', size: 60,
    blob: new Blob([Buffer.from('524946463400000057415645666d74201000000001000100401f0000803e0000020010006461746110000000000000400000c0ff0000a00060000000', 'hex')], { type: 'audio/wav' }) }
  source.size = source.blob.size
  const project = createProject('Audio source in two faces')
  const front = { mode: 'waveform', waveColour: '#839282a0', progressColour: '#165e36', playheadColour: '#612' }
  const back = { mode: 'compact', waveColour: '#acec', progressColour: '#1297c8', playheadColour: '#2b3caaa0' }
  const card = makeObject('audio', { x: 10, y: 22 }, { name: 'Synthetic chime', mode: 'card', assetId: source.id,
    audioAppearance: front, back: { title: 'Reverse chime', text: '', assetId: source.id, audioAppearance: back } })
  const shared = makeObject('file', { x: 10, y: 200 }, { name: 'Independent attachment', assetId: source.id,
    audioAppearance: { mode: 'waveform', waveColour: '#334455' } })
  project.objects = [card, shared]
  return { source, project, card, front, back }
}

test('version 4 packages round-trip independent Front and Back, original bytes and remapped object IDs', async () => {
  const { source, project, card, front, back } = fixture()
  const file = await makeProjectPackage([project], project.id, {}, [source])
  const zip = unzipSync(await readBlob(file))
  const manifest = JSON.parse(decode.decode(zip['manifest.json']))
  assert.equal(manifest.version, 4)
  assert.equal(manifest.assets.length, 1)
  assert.deepEqual(Object.keys(zip).sort(), [manifest.assets[0].path, 'manifest.json'].sort())
  const { projects: [restored], assets: [media] } = await importProject(file)
  assert.equal(digest(await readBlob(media.blob)), digest(await readBlob(source.blob)))
  const [copy, shared] = restored.objects
  assert.notEqual(copy.id, card.id)
  assert.notEqual(copy.assetId, source.id)
  assert.equal(copy.back.assetId, copy.assetId)
  assert.equal(shared.assetId, copy.assetId)
  assert.deepEqual(copy.audioAppearance, front)
  assert.deepEqual(copy.back.audioAppearance, back)
  assert.equal(shared.audioAppearance.waveColour, '#334455')
  copy.audioAppearance.waveColour = '#a1a2a3'
  assert.notEqual(copy.back.audioAppearance.waveColour, copy.audioAppearance.waveColour)
  assert.equal(front.waveColour, '#839282a0')

  const payload = version => new Blob([JSON.stringify({ ...manifest, version })])
  await assert.rejects(importProject(payload(3)), /requires a version 4/)
  manifest.projects[0].objects[0].audioAppearance.mode = 'invalid'
  await assert.rejects(importProject(payload(4)), /Unsupported audio display mode/)
  manifest.projects[0].objects[0].audioAppearance.mode = 'compact'
  manifest.projects[0].objects[0].audioAppearance.progressColour = 'url(#x)'
  await assert.rejects(importProject(payload(4)), /Invalid audio waveform colour/)
  manifest.projects[0].objects[0].audioAppearance.progressColour = '#165e36'
  manifest.assets[0].mime = 'text/plain'
  await assert.rejects(importProject(payload(4)), /Audio appearance requires an audio source/)
})

test('workspace version 4 backup and Save As preserve audio settings independently of original and history', async () => {
  const { source, project, front, back } = fixture()
  const earlier = structuredClone(project)
  earlier.objects[0].audioAppearance.progressColour = '#c669de'
  const version = { id: 'v1', projectId: project.id, project: earlier, createdAt: project.createdAt, number: 1, notes: '', descendants: [] }
  const recovery = { id: 'r1', projectId: project.id, project: earlier, createdAt: project.createdAt }
  const pieces = []
  await streamWorkspaceBackup({ projects: [project], assets: [source], versions: [version], recoveries: [recovery] }, {
    async write(chunk) { pieces.push(chunk.slice()) },
  })
  assert.equal(decode.decode(pieces[0]), 'CROFT WORKSPACE BACKUP 4\n')
  const parsed = await parseWorkspaceBackup(new Blob(pieces))
  const restored = cloneWorkspaceBackup(parsed)
  const card = restored.projects[0].objects[0]
  assert.equal(card.assetId, restored.assets[0].id)
  assert.deepEqual(card.audioAppearance, front)
  assert.deepEqual(card.back.audioAppearance, back)
  assert.equal(digest(await readBlob(restored.assets[0].blob)), digest(await readBlob(source.blob)))
  assert.equal(restored.versions[0].project.objects[0].audioAppearance.progressColour, '#c669de')
  assert.equal(restored.recoveries[0].project.objects[0].audioAppearance.progressColour, '#c669de')
  card.back.audioAppearance.mode = 'waveform'
  assert.equal(parsed.projects[0].objects[0].back.audioAppearance.mode, 'compact')
  assert.equal(restored.recoveries[0].project.objects[0].back.audioAppearance.mode, 'compact')
  const [copy] = cloneProjectTree([project], project.id, 'Independent copy')
  copy.objects[0].audioAppearance.progressColour = '#234531'
  assert.equal(project.objects[0].audioAppearance.progressColour, '#165e36')
  await assert.rejects(parseWorkspaceBackup(new Blob(['CROFT WORKSPACE BACKUP 3\n', ...pieces.slice(1)])), /requires a version 4/)
  const linked = { ...source, blob: undefined, linked: true }
  const linkedPieces = []
  await streamWorkspaceBackup({ projects: [project], assets: [linked], versions: [], recoveries: [] }, { async write(chunk) { linkedPieces.push(chunk.slice()) } })
  const linkedBackup = await parseWorkspaceBackup(new Blob(linkedPieces))
  assert.equal(linkedBackup.assets[0].blob, undefined)
  assert.equal(linkedBackup.assets[0].linked, true)
  assert.deepEqual(linkedBackup.projects[0].objects[0].back.audioAppearance, back)
})

test('older audio defaults and unavailable static output never invent or embed a waveform source', async () => {
  const { source, project } = fixture()
  const plain = createProject('Legacy audio')
  plain.objects = [makeObject('audio', { x: 10, y: 22 }, { assetId: source.id })]
  const file = await makeProjectPackage([plain], plain.id, {}, [source])
  const zip = unzipSync(await readBlob(file))
  assert.equal(JSON.parse(decode.decode(zip['manifest.json'])).version, 1)
  const { projects: [restored] } = await importProject(file)
  assert.equal(restored.objects[0].audioAppearance, undefined)
  assert.equal(resolvedAudioAppearance(undefined, false).mode, 'waveform')
  assert.notEqual(resolvedAudioAppearance(undefined, true).waveColour, resolvedAudioAppearance(undefined, false).waveColour)
  assert.equal(formatAudioTime(3665.5), '1:01:05')
  assert.equal(formatAudioTime(75.7), '1:15')
  assert.throws(() => readAudioAppearance({ mode: 'waveform', unexpected: true }), /Invalid audio appearance/)
  const { blob } = await renderProjectSvg(project, {}, [{ ...source, blob: undefined, linked: true }])
  const markup = await blob.text()
  assert.match(markup, /Synthetic chime/)
  assert.match(markup, /Waveform unavailable/)
  assert.doesNotMatch(markup, /data:audio|<audio|data-audio-waveform="unplayed"/)
})
