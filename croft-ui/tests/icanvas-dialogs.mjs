import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [playwrightPath, chromePath, origin = 'http://localhost:5173'] = process.argv.slice(2)
if (!playwrightPath || !chromePath) throw new Error('Provide the Playwright package path and Chrome executable path.')
const { chromium } = await import(pathToFileURL(path.resolve(playwrightPath, 'index.mjs')).href)
const browser = await chromium.launch({ executablePath: chromePath, chromiumSandbox: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto(origin)
  await page.locator('.ic-project-open').filter({ hasText: 'Holiday Ideas' }).click()
  const canvas = page.getByRole('region', { name: 'Canvas', exact: true })
  await canvas.waitFor()
  const files = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['iCanvas test import.'], 'accepted.txt', { type: 'text/plain' }))
    transfer.items.add(new File(['<html>Active markup</html>'], 'rejected.html', { type: 'text/html' }))
    return transfer
  })
  const bounds = await canvas.boundingBox()
  assert.ok(bounds)
  await canvas.dispatchEvent('drop', {
    dataTransfer: files,
    clientX: bounds.x + bounds.width / 2,
    clientY: bounds.y + bounds.height / 2,
  })
  const importer = page.getByRole('dialog', { name: 'Add files' })
  await importer.waitFor()
  await importer.getByRole('button', { name: 'Expand' }).click()
  await importer.getByText('rejected.html').waitFor()
  assert.equal(await importer.getByRole('button', { name: 'Link In' }).first().isDisabled(), true)
  await importer.getByRole('button', { name: 'Add', exact: true }).click()
  await importer.getByRole('list', { name: 'Files skipped' }).getByText(/rejected.html/).waitFor()
  await importer.getByRole('button', { name: 'Done', exact: true }).click()
  await canvas.getByText('accepted.txt', { exact: true }).first().waitFor()
  assert.equal(await canvas.getByText('rejected.html', { exact: true }).count(), 0)

  await page.getByRole('button', { name: 'Save menu' }).click()
  await page.getByRole('button', { name: 'Save VC', exact: true }).click()
  const checkpoint = page.getByRole('dialog', { name: 'Save VC' })
  await checkpoint.getByLabel('Version notes (optional)').fill('Synthetic checkpoint')
  await checkpoint.getByRole('button', { name: 'Save version' }).click()
  await checkpoint.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Project menu' }).click()
  await page.getByRole('button', { name: 'Version History', exact: true }).click()
  const versionHistory = page.getByRole('dialog', { name: 'Version history' })
  await versionHistory.getByRole('button', { name: /v1.*Synthetic checkpoint/ }).click()
  await versionHistory.getByRole('region', { name: 'Saved canvas preview' }).waitFor()
  await versionHistory.getByRole('button', { name: 'Restore…', exact: true }).click()
  await versionHistory.getByRole('button', { name: 'Confirm restore' }).click()
  await versionHistory.waitFor({ state: 'hidden' })

  await page.getByRole('button', { name: 'Save menu' }).click()
  await page.getByRole('button', { name: 'Save As…', exact: true }).click()
  const copy = page.getByRole('dialog', { name: 'Save As…' })
  await copy.getByLabel('Name', { exact: true }).fill('Saved as a local copy')
  await copy.getByRole('button', { name: 'Create copy' }).click()
  await copy.waitFor({ state: 'hidden' })
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByText('Saved as a local copy', { exact: true }).waitFor()
  const details = page.getByRole('dialog', { name: 'Project Details' })
  if (await details.count()) await details.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.reload()
  await page.getByRole('navigation', { name: 'Canvas breadcrumbs' }).getByText('Saved as a local copy', { exact: true }).waitFor()
  const savedCopy = await page.evaluate(async () => {
    const read = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const db = await read(indexedDB.open('croft-icanvas'))
    try {
      const project = await read(db.transaction('projects').objectStore('projects').get(location.hash.split('/')[1]))
      const copy = project?.objects.find(item => item.name === 'accepted.txt')
      const asset = copy?.assetId && await read(db.transaction('assets').objectStore('assets').get(copy.assetId))
      return { content: await asset?.blob?.text(), rejected: project?.objects.some(item => item.name === 'rejected.html') }
    } finally {
      db.close()
    }
  })
  assert.deepEqual(savedCopy, { content: 'iCanvas test import.', rejected: false })
  assert.deepEqual(pageErrors, [])
  console.log('iCanvas dialogs passed: compact import, partial-success feedback, file reload, Save VC, version preview/restore, and Save As.')
} finally {
  await browser.close()
}
