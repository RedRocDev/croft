import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileAccessProblem, readLinkedFile, requestFileRead } from '../src/features/icanvas/linkedFiles.ts'

const sample = new File(['Croft sample'], 'reference.txt', { type: 'text/plain' })
const metadata = { name: sample.name, size: sample.size, mime: sample.type }
const detect = async file => file.type

test('prompt or denied does not read bytes or request permission during rendering', async () => {
  for (const permission of ['prompt', 'denied']) {
    const handle = {
      async queryPermission(options) {
        assert.deepEqual(options, { mode: 'read' })
        return permission
      },
      requestPermission: () => assert.fail('Rendering must not prompt.'),
      getFile: () => assert.fail('Rendering must not read denied file bytes.'),
    }
    assert.deepEqual(await readLinkedFile({ ...metadata, handle }, detect), { problem: permission })
  }
})

test('explicit permission request is read-only and the handle remains a usable legacy format', async () => {
  const handle = {
    async requestPermission(options) {
      assert.deepEqual(options, { mode: 'read' })
      return 'granted'
    },
    async getFile() { return sample },
  }
  assert.equal(await requestFileRead(handle), 'granted')
  assert.deepEqual(await readLinkedFile({ ...metadata, handle }, detect), { file: sample })
})

test('missing and denied filesystem reads report distinct states', async () => {
  const handle = name => ({
    async queryPermission() { return 'granted' },
    async getFile() { throw new DOMException('Unavailable', name) },
  })
  assert.deepEqual(await readLinkedFile({ ...metadata, handle: handle('NotFoundError') }, detect), { problem: 'missing' })
  assert.deepEqual(await readLinkedFile({ ...metadata, handle: handle('NotAllowedError') }, detect), { problem: 'denied' })
  assert.deepEqual(await readLinkedFile({ ...metadata, handle: handle('SecurityError') }, detect), { problem: 'unavailable' })
  assert.equal(fileAccessProblem(new Error('Other failure')), 'unavailable')
})

test('a differently named, sized or unsafe file must be relinked explicitly', async () => {
  const handle = { async getFile() { return sample } }
  for (const changed of [{ name: 'renamed.txt' }, { size: sample.size + 1 }, { mime: 'application/pdf' }]) {
    assert.deepEqual(await readLinkedFile({ ...metadata, ...changed, handle }, detect), { problem: 'changed' })
  }
  const rejectContents = async () => { throw new Error('Active content') }
  assert.deepEqual(await readLinkedFile({ ...metadata, handle }, rejectContents), { problem: 'changed' })
})
