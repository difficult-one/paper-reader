import { createServer } from 'node:http'
import assert from 'node:assert/strict'

export async function addScrollAnnotations(page, path, perPage) {
  const expected = await page.evaluate(async ({ path, perPage }) => {
    const result = await window.reader.openPdf(path)
    if (!result.ok) throw new Error(result.error)
    const session = result.value
    for (const sourceKey of ['original', `translated:${session.translationKey}`]) {
      for (let start = 1; start <= session.pages; start += 100) {
        const anchors = Array.from({ length: Math.min(100, session.pages - start + 1) }, (_, index) => ({ page: start + index,
          rects: Array.from({ length: perPage }, (_, row) => ({ x: .08, y: .08 + row * .022, width: .8, height: .012 })) }))
        const saved = await window.reader.addAnnotation(session.id, { sourceKey, quote: 'Performance fixture annotation', note: '', color: 'yellow', anchors })
        if (!saved.ok) throw new Error(saved.error)
      }
    }
    return session.pages * perPage * 2
  }, { path, perPage })
  await page.reload()
  await page.waitForFunction(expected => document.querySelectorAll('.highlight-mark').length === expected, expected, { timeout: 30000 })
  return expected
}

export async function startScrollBackground(app, page, path) {
  let chunks = 0; let requests = 0
  const intervals = new Set()
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.stream, true)
    requests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const timer = setInterval(() => {
      chunks++
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `本地模拟流式结果 ${chunks}，用于验证界面更新和连续阅读同时进行。` } }] })}\n\n`)
    }, 100)
    intervals.add(timer)
    response.on('close', () => { clearInterval(timer); intervals.delete(timer) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  await page.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
  await page.getByLabel('API 密钥', { exact: true }).fill('performance-local-fixture-only')
  await page.getByLabel('模型名称', { exact: true }).fill('performance-fixture')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.waitForFunction(() => {
    const slot = document.querySelector('[data-side="left"] [data-page="1"]')
    const layer = slot?.querySelector('.textLayer')
    return slot?.querySelector('canvas')?.dataset.quality === 'clear' && layer?.querySelector('span') && Math.abs(parseFloat(layer.style.getPropertyValue('--total-scale-factor')) - parseFloat(slot.style.width) / 612) < .001
  })
  await page.locator('[data-side="left"] [data-page="1"] .textLayer span').first().evaluate(element => {
    element.closest('.pdf-scroll').focus({ preventScroll: true })
    const range = document.createRange(); range.selectNodeContents(element)
    getSelection().removeAllRanges(); getSelection().addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').waitFor({ state: 'visible' })
  await page.keyboard.press('Alt+q')
  await page.getByRole('button', { name: '解释术语', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.question-answer')?.textContent.includes('本地模拟流式结果'))
  const documentId = await page.evaluate(async path => (await window.reader.openPdf(path)).value.id, path)
  await app.evaluate(({ BrowserWindow }, documentId) => {
    const window = BrowserWindow.getAllWindows()[0]; let sequence = 0
    globalThis.performanceFixtureTimer = setInterval(() => {
      sequence++
      window.webContents.send('reader:job', { id: 'local-performance-job', documentId, status: 'running', stage: '本地性能夹具进度', percent: sequence % 100,
        startedAt: Date.now() - sequence * 50, logs: Array.from({ length: 150 }, (_, i) => `模拟后台进度 ${sequence}-${i}`) })
      if (sequence % 100 === 0) window.setSize(sequence % 200 ? 1200 : 1440, sequence % 200 ? 800 : 960)
    }, 50)
  }, documentId)
  return async () => {
    await app.evaluate(() => { clearInterval(globalThis.performanceFixtureTimer); delete globalThis.performanceFixtureTimer })
    if (await page.getByRole('button', { name: '停止生成', exact: true }).count()) await page.getByRole('button', { name: '停止生成', exact: true }).click()
    for (const timer of intervals) clearInterval(timer)
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
    assert(requests > 0 && chunks >= 100, 'background run must exercise a live local stream')
    return { requests, chunks, windowResizing: '1200×800 / 1440×960 every 5 seconds', translationProgress: 'Synthetic IPC updates at 20 Hz; no remote translation call or real translation CPU workload.' }
  }
  } catch (error) {
    console.error(JSON.stringify({ backgroundSetup: { requests, chunks, panel: await page.locator('.question-panel').innerText().catch(() => ''),
      panes: await page.locator('[data-page="1"]').evaluateAll(slots => slots.map(slot => ({ side: slot.closest('[data-side]').dataset.side, width: slot.style.width, quality: slot.querySelector('canvas')?.dataset.quality, text: slot.querySelectorAll('.textLayer span').length, scale: slot.querySelector('.textLayer')?.style.getPropertyValue('--total-scale-factor'), error: slot.querySelector('.page-error')?.textContent }))).catch(() => []),
      body: (await page.locator('body').innerText().catch(() => '')).slice(-1500) } }))
    await app.evaluate(() => { clearInterval(globalThis.performanceFixtureTimer) }).catch(() => {})
    for (const timer of intervals) clearInterval(timer)
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
    throw error
  }
}
