import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const [playwrightPath, chromePath] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const require = createRequire(import.meta.url)
const ts = require('typescript')
const base = fileURLToPath(new URL('../src/features/icanvas/', import.meta.url))
const dom = '<!doctype html><title>iCanvas storage test</title>'
const server = createServer(async (request, response) => {
  const route = new URL(request.url, 'http://127.0.0.1').pathname
  if (route === '/') {
    response.setHeader('content-type', 'text/html')
    response.end(dom)
  } else if (['/storage', '/model', '/model.ts', '/writerLock.ts', '/stackPersistence.ts'].includes(route)) {
    const source = await readFile(path.join(base, route.slice(1).replace(/\.ts$/, '') + '.ts'), 'utf8')
    response.setHeader('content-type', 'text/javascript')
    response.end(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
  } else {
    response.writeHead(404).end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({ executablePath: chromePath, headless: true, chromiumSandbox: true })
  console.log('Chrome', browser.version())
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const results = await page.evaluate(async () => {
    const store = await import('/storage')
    const { requestWorkspaceWriter } = await import('/writerLock.ts')
    const { createProject, makeObject } = await import('/model')
    function check(condition, message) { if (!condition) throw new Error(message) }
    async function rejects(promise, pattern) {
      try { await promise } catch (error) {
        check(pattern.test(String(error)), String(error))
        return
      }
      throw new Error('Expected operation to fail.')
    }

    check((await requestWorkspaceWriter()).writable, 'The test tab could not acquire the writer lease.')
    const root = createProject('Trip')
    const child = createProject('Hotels', root.id)
    const asset = { id: 'synthetic-data', name: 'sample.txt', mime: 'text/plain', size: 11, blob: new Blob(['test sample'], { type: 'text/plain' }) }
    root.objects = [
      makeObject('file', { x: 50, y: 100 }, { assetId: asset.id }),
      makeObject('canvas', { x: 320, y: 100 }, { targetId: child.id }),
    ]
    await store.saveProjects([root, child], [asset])
    await rejects(store.saveProjects([{ ...root, parentId: child.id }], [
      { ...asset, id: 'should-roll-back' },
    ]), /SubCanvas/)
    check(!(await store.getAsset('should-roll-back')), 'A failed hierarchy transaction retained a new asset.')
    check((await store.getProjects()).find(project => project.id === root.id).parentId === null, 'Cycle validation changed the root.')
    const missingAssetId = 'missing'
    await rejects(store.saveProjects([{ ...root, coverAssetId: missingAssetId }]), /missing/)
    check((await store.getProjects()).find(project => project.id === root.id).coverAssetId === undefined, 'A failed asset check modified project state.')

    const v1 = await store.saveVersion(root, 'First map', [root, child])
    const amended = { ...root, name: 'Updated Trip', updatedAt: root.updatedAt + 1 }
    const childEdited = { ...child, name: 'Hotels shortlist', updatedAt: child.updatedAt + 1 }
    await rejects(store.saveProjects([{ ...amended, updatedAt: root.updatedAt - 1 }]), /more recently/)
    const v2 = await store.saveVersion(amended, 'Fresh details', [amended, childEdited])
    check(v1.number === 1 && v2.number === 2, 'Numbered versions are out of order.')
    check(v2.descendants[0].name === childEdited.name, 'Version missed live descendant edits.')
    const v3Restore = await store.restoreVersion(amended, v1.id)
    const updatedTree = await store.getProjects()
    check(v3Restore.name === root.name, 'Version did not restore the root.')
    check(updatedTree.find(project => project.id === child.id).name === child.name, 'Version did not restore the child.')
    check((await store.getVersions(root.id)).map(version => version.number).join(',') === '3,2,1', 'Restoring should create a checkpoint.')
    const copied = store.cloneProjectTree(updatedTree, root.id, 'Trip copy')
    await store.saveProjects(copied)
    check(copied[1].parentId === copied[0].id && copied[0].objects[1].targetId === copied[1].id, 'Copy references still target the original.')
    check(copied[0].objects[0].assetId === asset.id, 'Copy lost its immutable asset reference.')

    for (let changes = 1; changes <= 12; changes++) {
      await store.saveRecovery({ ...v3Restore, description: `draft ${changes}`, updatedAt: v3Restore.updatedAt + changes })
    }
    check((await store.getRecoveries(root.id)).length === 10, 'Recovery snapshots exceeded their retained limit.')
    check(!await store.saveRecovery({ ...v3Restore, description: 'draft 12', updatedAt: v3Restore.updatedAt + 13 }), 'Identical recovery was duplicated.')
    const invalid = { ...v3Restore, name: '', updatedAt: v3Restore.updatedAt + 14 }
    await rejects(store.manualSave([invalid], root.id), /invalid/)
    check((await store.getRecoveries(root.id)).length === 10, 'Recovery snapshots were lost after a failed manual save.')
    const newestRecovery = (await store.getRecoveries(root.id))[0]
    const restoredDraft = await store.restoreRecovery(v3Restore, newestRecovery.id)
    check(restoredDraft.description === 'draft 12', 'Recovering a draft did not update the head.')
    check((await store.getVersions(root.id))[0].notes === 'Before restoring recovery copy', 'Recovery did not preserve the prior state.')
    const final = { ...restoredDraft, name: 'Saved Trip', updatedAt: restoredDraft.updatedAt + 1 }
    await store.manualSave([final], root.id)
    check(!(await store.getRecoveries(root.id)).length, 'Manual save did not clear temporary recovery.')
    check((await store.getVersions(root.id)).length === 4, 'Manual save cleared explicit versions.')
    return { rootId: root.id, childId: child.id, copyId: copied[0].id, assetId: asset.id }
  })
  await page.reload()
  const afterReload = await page.evaluate(async ids => {
    const store = await import('/storage')
    const projects = await store.getProjects()
    const asset = await store.getAsset(ids.assetId)
    return {
      names: [ids.rootId, ids.childId, ids.copyId].map(id => projects.find(project => project.id === id)?.name),
      asset: await asset?.blob?.text(),
      versions: (await store.getVersions(ids.rootId)).length,
    }
  }, results)
  assert.deepEqual(afterReload, { names: ['Saved Trip', 'Hotels', 'Trip copy'], asset: 'test sample', versions: 4 })
  console.log('IndexedDB storage passed: atomic asset + hierarchy commits, rollback, Save As, checkpoints, recovery cap, verified manual save, and reload.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
