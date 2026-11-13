import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROFT_QA_PLAYWRIGHT || 'playwright')
const origin = new URL(process.env.CROFT_QA_URL || 'http://localhost:5173')
assert.ok(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))

const providers = [
  { name: 'YouTube', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', request: /youtube-nocookie\.com\/embed\/jNQXAC9IVRw/ },
  { name: 'X', url: 'https://x.com/i/status/20', request: /platform\.twitter\.com\/embed\/Tweet\.html/ },
]
const isProviderRequest = value => /(^|\.)(youtube(?:-nocookie)?\.com|youtu\.be|twitter\.com|x\.com|twimg\.com)$/.test(new URL(value).hostname)
const browser = await chromium.launch({
  ...(process.env.CROFT_QA_CHROME ? { executablePath: process.env.CROFT_QA_CHROME } : { channel: 'chrome' }),
  headless: true,
  chromiumSandbox: true,
})

try {
  for (const provider of providers) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    let page = await context.newPage()
    page.setDefaultTimeout(12_000)
    const pageErrors = []
    const providerRequests = []
    const providerResponses = []
    const consoleErrors = []
    const monitor = target => {
      target.on('pageerror', error => { if (!error.stack || error.stack.includes(origin.origin)) pageErrors.push(error.message) })
      target.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
      target.on('request', request => { if (isProviderRequest(request.url())) providerRequests.push(request.url()) })
      target.on('response', response => {
        if (isProviderRequest(response.url())) providerResponses.push({ url: response.url(), status: response.status() })
      })
    }
    monitor(page)

    await page.goto(origin.href, { waitUntil: 'networkidle' })
    await page.getByRole('region', { name: 'Canvas projects' }).getByRole('button', { name: /Holiday Ideas A visual itinerary/ }).click()
    const stage = page.getByRole('region', { name: 'Canvas', exact: true })
    await stage.waitFor()
    await page.waitForTimeout(250)

    await stage.evaluate((element, url) => {
      const data = new DataTransfer()
      data.setData('text/plain', url)
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    }, provider.url)
    const smartlinkObject = page.locator(`[data-kind="smartlink"][aria-label="${provider.name}"]`)
    await smartlinkObject.waitFor()
    const identity = await smartlinkObject.getAttribute('data-testid')
    const geometry = await smartlinkObject.evaluate(element => ({ left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height, transform: element.style.transform }))

    if (provider.name === 'YouTube') {
      const displayMode = page.locator('.ic-inspector fieldset').filter({ hasText: 'Display mode' }).locator('select')
      await displayMode.selectOption('preview')
      await smartlinkObject.locator('.ic-smartlink-preview').waitFor()
      await displayMode.selectOption('link')
      await smartlinkObject.locator('.ic-smartlink-link').waitFor()
      await displayMode.selectOption('embed')

      const faces = page.getByRole('group', { name: 'Card faces', exact: true })
      await faces.getByRole('button', { name: 'Show Back', exact: true }).click()
      await page.getByRole('button', { name: 'Add Smartlink…', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Edit Smartlink', exact: true })
      await editor.locator('input[type="url"]').fill('https://x.com/i/status/20')
      await editor.locator('input').nth(1).fill('Back post')
      await editor.locator('textarea').fill('Independent reverse-side note.')
      await editor.getByRole('button', { name: 'Save Smartlink', exact: true }).click()
      await editor.waitFor({ state: 'hidden' })
      assert.equal(await smartlinkObject.getAttribute('data-testid'), identity, 'Adding reverse-side content changed the object ID.')
      assert.deepEqual(await smartlinkObject.evaluate(element => ({ left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height, transform: element.style.transform })), geometry)
      await faces.getByRole('button', { name: 'Show Front', exact: true }).click()
    }

    const consent = page.locator('.ic-smartlink-consent')
    await consent.waitFor()
    await page.waitForTimeout(750)
    assert.deepEqual(providerRequests, [], `${provider.name} was contacted before consent.`)
    assert.equal(await smartlinkObject.getAttribute('data-testid'), identity, 'Changing display mode changed the object ID.')
    assert.deepEqual(await smartlinkObject.evaluate(element => ({ left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height, transform: element.style.transform })), geometry,
      'Changing display mode changed the object geometry.')

    await consent.getByRole('button', { name: 'Load Once', exact: true }).click()
    const zoomPrompt = page.getByRole('button', { name: 'Zoom to Play', exact: true })
    await zoomPrompt.waitFor()
    assert.deepEqual(providerRequests, [], `${provider.name} was contacted before the user chose to load it.`)
    const providerResponse = page.waitForResponse(response => provider.request.test(response.url()), { timeout: 15_000 })
    await zoomPrompt.click()

    await page.locator('iframe.ic-smartlink-provider-frame').waitFor()
    const response = await providerResponse
    assert.equal(response.status(), 200, `${provider.name} embed returned HTTP ${response.status()}.`)
    assert.ok(providerRequests.some(url => provider.request.test(url)), `${provider.name} provider request was not observed after consent.`)

    if (provider.name === 'X') {
      let postFrame
      for (let attempt = 0; attempt < 20 && !postFrame; attempt++) {
        postFrame = page.frames().find(frame => frame.url().startsWith('https://platform.twitter.com/embed/Tweet.html'))
        if (!postFrame) await page.waitForTimeout(250)
      }
      if (!postFrame) console.error(`X frame diagnostics: ${JSON.stringify({ frames: page.frames().map(frame => frame.url()), iframe: await page.locator('iframe.ic-smartlink-provider-frame').evaluate(element => ({ src: element.src, sandbox: element.getAttribute('sandbox') })) })}`)
      assert.ok(postFrame, 'The official X post frame was not created.')
      await postFrame.getByText('just setting up my twttr', { exact: false }).waitFor()
      console.log(`X: official post ${provider.url} returned HTTP 200 and rendered its actual public post text.`)
    } else {
      let player
      for (let attempt = 0; attempt < 20 && !player; attempt++) {
        player = page.frames().find(frame => frame.url().includes('/embed/jNQXAC9IVRw'))
        if (!player) await page.waitForTimeout(250)
      }
      if (!player) console.error(`YouTube frame diagnostics: ${JSON.stringify({ frames: page.frames().map(frame => frame.url()), iframe: await page.locator('iframe.ic-smartlink-provider-frame').evaluate(element => ({ src: element.src, sandbox: element.getAttribute('sandbox') })) })}`)
      assert.ok(player, 'The official YouTube player frame was not created.')
      await player.waitForFunction(() => !!document.querySelector('#movie_player video'), undefined, { timeout: 12_000 })
      const playerInfo = await player.evaluate(() => ({
        title: document.title,
        player: !!document.querySelector('#movie_player'),
        video: !!document.querySelector('#movie_player video'),
      }))
      assert.equal(playerInfo.video, true)
      console.log(`YouTube: official player document responded HTTP 200 and exposed the player/video DOM (${JSON.stringify(playerInfo)}).`)
    }

    assert.equal(await page.evaluate(() => localStorage.getItem('croft.external-content.v1')), null, 'Load Once must not persist as a provider permission.')
    await page.waitForTimeout(2_300)
    await page.waitForFunction(async expected => {
      const open = await new Promise((resolve, reject) => {
        const request = indexedDB.open('croft-icanvas')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise((resolve, reject) => {
          const tx = open.transaction('projects', 'readonly')
          const project = tx.objectStore('projects').get(location.hash.split('/')[1])
          project.onsuccess = () => resolve(project.result?.objects?.some(item => item.smartlink?.canonicalUrl === expected.url &&
            (!expected.back || item.back?.smartlink?.canonicalUrl === expected.back)) ?? false)
          project.onerror = () => reject(project.error)
        })
      } finally { open.close() }
    }, { url: provider.url, back: provider.name === 'YouTube' ? 'https://x.com/i/status/20' : undefined }, { timeout: 8_000 })
    const canvasUrl = page.url()
    await page.close()
    await new Promise(resolve => setTimeout(resolve, 1_000))
    providerRequests.length = 0
    page = await context.newPage()
    page.setDefaultTimeout(12_000)
    monitor(page)
    await page.goto(canvasUrl, { waitUntil: 'networkidle' })
    const reopenedConsent = page.locator('.ic-smartlink-consent')
    await reopenedConsent.waitFor()
    await page.waitForTimeout(500)
    assert.deepEqual(providerRequests, [], `${provider.name} permission persisted after closing the tab.`)

    const alwaysAllow = reopenedConsent.getByRole('button', { name: `Always Allow ${provider.name}`, exact: true })
    const alwaysAllowResponse = page.waitForResponse(response => provider.request.test(response.url()), { timeout: 15_000 })
    await alwaysAllow.click()
    const zoomAgain = page.getByRole('button', { name: 'Zoom to Play', exact: true })
    if (await zoomAgain.count()) await zoomAgain.click()
    const allowedResponse = await alwaysAllowResponse
    assert.equal(allowedResponse.status(), 200)
    assert.equal(await page.evaluate(providerName => JSON.parse(localStorage.getItem('croft.external-content.v1'))[providerName], provider.name.toLowerCase()), 'allow')

    await page.waitForTimeout(2_300)
    const allowCanvasUrl = page.url()
    await page.close()
    providerRequests.length = 0
    page = await context.newPage()
    page.setDefaultTimeout(12_000)
    monitor(page)
    const persistedAllowResponse = page.waitForResponse(response => provider.request.test(response.url()), { timeout: 15_000 })
    await page.goto(allowCanvasUrl, { waitUntil: 'domcontentloaded' })
    assert.equal((await persistedAllowResponse).status(), 200)
    assert.equal(await page.locator('.ic-smartlink-consent').count(), 0, `${provider.name} asked again despite the saved Always Allow preference.`)
    assert.equal(await page.evaluate(providerName => JSON.parse(localStorage.getItem('croft.external-content.v1'))[providerName], provider.name.toLowerCase()), 'allow')

    await page.goto(origin.href, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Workspace settings' })
    await settings.getByRole('button', { name: 'Privacy', exact: true }).click()
    await settings.getByRole('heading', { name: 'External Content', exact: true }).waitFor()
    const providerSettings = settings.locator('fieldset').filter({ hasText: provider.name })
    await providerSettings.getByRole('radio', { name: 'Ask before loading' }).check()
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('croft.external-content.v1')))[provider.name.toLowerCase()], 'ask')
    assert.deepEqual(pageErrors, [], `${provider.name} caused an application error.`)
    await context.close()
  }
} finally {
  await browser.close()
}
