import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unzipSync } from 'fflate'
import { createProject, makeObject } from '../src/features/icanvas/model.ts'
import { createStack } from '../src/features/icanvas/stackScene.ts'
import { importProject, makeProjectPackage, renderProjectSvg } from '../src/features/icanvas/portability.ts'
import { cloneWorkspaceBackup, parseWorkspaceBackup, streamWorkspaceBackup } from '../src/features/icanvas/workspaceBackup.ts'
import { parseSmartlink, readSmartlink } from '../src/features/icanvas/smartlinks.ts'

const youtube = 'https://www.youtube.com/watch?v=AbCdEfGh_12'
const xUrl = 'https://x.com/FieldNotes/status/184467440737095516159'

function fixture() {
  const project = createProject('Smartlink persistence')
  const front = makeObject('note', { x: 16, y: 24 }, {
    name: 'Video reference', text: 'Local note', smartlink: parseSmartlink(`${youtube}&t=1m20s`),
  })
  front.back = { title: 'Back notes', text: 'Private reminders', smartlink: { ...parseSmartlink(xUrl), mode: 'link', title: 'Public post', notes: 'Remember this source.' } }
  const buried = makeObject('note', { x: 300, y: 24 }, {
    name: 'Buried post', smartlink: { ...parseSmartlink(xUrl), title: 'Stack member' },
  })
  const stack = createStack([buried, front], [front.id, buried.id])
  project.objects = stack.objects
  return { project, frontId: front.id, buriedId: buried.id, stackId: stack.stackId }
}

test('recognises supported YouTube forms and canonicalises start time without forwarding tracking input', () => {
  assert.deepEqual(parseSmartlink('https://youtu.be/AbCdEfGh_12?si=privateShare&t=90'), {
    provider: 'youtube', canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEfGh_12&t=90s', contentId: 'AbCdEfGh_12', startSeconds: 90, mode: 'embed',
  })
  assert.equal(parseSmartlink('http://m.youtube.com/shorts/AbCdEfGh_12?start=65').canonicalUrl,
    'https://www.youtube.com/watch?v=AbCdEfGh_12&t=65s')
  assert.equal(parseSmartlink('https://youtube-nocookie.com/embed/AbCdEfGh_12').provider, 'youtube')
  assert.equal(parseSmartlink('https://youtube.com/watch?v=AbCdEfGh_12&v=ZzZzZzZzZzZ').provider, 'website')
  assert.equal(parseSmartlink('https://youtube.com/playlist?list=PL123').provider, 'website')
})

test('recognises public X post routes and keeps long post IDs as strings', () => {
  for (const url of [xUrl, 'https://twitter.com/FieldNotes/status/184467440737095516159/photo/1',
    'https://x.com/i/status/184467440737095516159', 'https://x.com/i/web/status/184467440737095516159']) {
    const link = parseSmartlink(url)
    assert.equal(link.provider, 'x')
    assert.equal(link.contentId, '184467440737095516159')
    assert.equal(link.canonicalUrl, 'https://x.com/i/status/184467440737095516159')
  }
  assert.equal(parseSmartlink('https://x.com/FieldNotes').provider, 'website')
  assert.equal(parseSmartlink('https://t.co/abc123').provider, 'website')
})

test('rejects unsafe destinations and never misclassifies look-alike hosts as providers', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'blob:https://cro.ft/id', 'file:///C:/private.txt',
    'https://youtube.com:444/watch?v=AbCdEfGh_12', 'https://youtube.com@attacker.example/watch?v=AbCdEfGh_12',
    '<iframe src="https://youtube.com/embed/AbCdEfGh_12"></iframe>']) assert.equal(parseSmartlink(url), undefined, url)
  assert.equal(parseSmartlink('https://youtube.com.attacker.example/watch?v=AbCdEfGh_12').provider, 'website')
  assert.equal(parseSmartlink('https://x.com.attacker.example/FieldNotes/status/123').provider, 'website')
  assert.equal(parseSmartlink('https://example.test/?next=https%3A%2F%2Fx.com%2Fi%2Fstatus%2F123').provider, 'website')
  assert.equal(parseSmartlink('https://xn--x-3ga.com/FieldNotes/status/123').provider, 'website')
  assert.equal(parseSmartlink('https://example.test/a path'), undefined)
  assert.throws(() => readSmartlink({ ...parseSmartlink('https://example.test/bookmark'), mode: 'embed' }), /cannot use live embed/i)
})

test('validates imported provider identity, canonical URL, IDs and text bounds', () => {
  const parsed = parseSmartlink(xUrl)
  assert.equal(readSmartlink(parsed).contentId, parsed.contentId)
  assert.throws(() => readSmartlink({ ...parsed, provider: 'youtube' }), /provider|identity|URL/i)
  assert.throws(() => readSmartlink({ ...parsed, contentId: 'not-the-post' }), /identity/i)
  assert.throws(() => readSmartlink({ ...parsed, canonicalUrl: 'https://x.com.attacker.example/i/status/123' }), /provider|URL/i)
  assert.throws(() => readSmartlink({ ...parsed, notes: 'x'.repeat(16_385) }), /notes/i)
})

test('portable packages preserve front/back Smartlinks and hidden stack members without session grants', async () => {
  const { project, frontId, buriedId, stackId } = fixture()
  const pack = await makeProjectPackage([project], project.id, { scope: 'canvas' })
  const zipped = unzipSync(new Uint8Array(await pack.arrayBuffer()))
  const manifest = JSON.parse(new TextDecoder().decode(zipped['manifest.json']))
  assert.equal(manifest.version, 5)
  const restored = await importProject(pack)
  const copy = restored.projects[0]
  const copiedFront = copy.objects.find(object => object.name === 'Video reference')
  const copiedBackMember = copy.objects.find(object => object.name === 'Buried post')
  assert.equal(copiedFront.smartlink.contentId, 'AbCdEfGh_12')
  assert.equal(copiedFront.back.smartlink.contentId, '184467440737095516159')
  assert.equal(copiedFront.back.smartlink.notes, 'Remember this source.')
  assert.equal(copiedBackMember.smartlink.title, 'Stack member')
  assert.notEqual(copy.objects.find(object => object.kind === 'stack').id, stackId)
  assert.notEqual(copiedFront.id, frontId)
  assert.notEqual(copiedBackMember.id, buriedId)
  const svg = await (await renderProjectSvg(copy)).blob.text()
  assert.match(svg, /www\.youtube\.com\/watch\?v=AbCd/)
  assert.match(svg, /EfGh_12&amp;t=80s/)
  assert.match(svg, /YouTube video/)
  assert.doesNotMatch(svg, /<iframe|<script|<image[^>]+https:\/\//i)
})

test('full backups preserve both faces and stack references while permissions stay outside project data', async () => {
  const { project } = fixture()
  const state = { projects: [project], assets: [], versions: [], recoveries: [] }
  const chunks = []
  await streamWorkspaceBackup(state, { write: async chunk => chunks.push(new Uint8Array(chunk)) })
  const backup = new Blob(chunks, { type: 'application/octet-stream' })
  const restored = await parseWorkspaceBackup(backup)
  const clone = cloneWorkspaceBackup(restored)
  const copiedFront = clone.projects[0].objects.find(object => object.name === 'Video reference')
  assert.equal(copiedFront.smartlink.canonicalUrl, 'https://www.youtube.com/watch?v=AbCdEfGh_12&t=80s')
  assert.equal(copiedFront.back.smartlink.mode, 'link')
  assert.equal(clone.projects[0].objects.find(object => object.name === 'Buried post').smartlink.contentId, '184467440737095516159')
  assert.notEqual(copiedFront.id, project.objects.find(object => object.name === 'Video reference').id)
  assert.deepEqual(Object.keys(copiedFront.smartlink).sort(), ['canonicalUrl', 'contentId', 'mode', 'provider', 'startSeconds'])
})
