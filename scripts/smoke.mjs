import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { basename, dirname, resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
async function waitForBridge(page, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (!await page.evaluate(predicate)) {
    if (Date.now() > deadline) throw new Error('Bridge condition timed out')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
await mkdir('output/playwright', { recursive: true })
const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
for (let i = 1; i <= 4; i++) {
  const page = pdf.addPage([595, 842])
  page.drawText('A Bilingual Approach to Scientific Reading', { x: 48, y: 765, size: 19, font })
  page.drawText(`Page ${i} / Abstract and Methods`, { x: 48, y: 733, size: 12, font })
  for (let line = 0; line < 24; line++) page.drawText('Scientific translation may improve reading. Verify results and conditions.', { x: 48, y: 690 - line * 21, size: 11, font })
  page.drawRectangle({ x: 48, y: 98, width: 490, height: 70, borderWidth: 1 })
  page.drawText('Table 1: sample size = 42; p < 0.05; x = a + b', { x: 60, y: 135, size: 11, font })
}
const fixture = resolve('output/playwright/英文 paper.pdf'); await writeFile(fixture, await pdf.save())
let requestCount = 0
const usageHistory = []
let holdResponses = false
let blockedReady
const blockedResponses = []
const selectedModel = `smoke-${Date.now()}`
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: selectedModel, name: '用于翻译的指定模型' }] })); return
  }
  let raw = ''; for await (const chunk of request) raw += chunk
  try {
    const body = JSON.parse(raw)
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer smoke-only-api-key')
    assert.equal(body.model, selectedModel)
    requestCount++
    const prompt = body.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    let content = '连接成功'
    if (prompt.includes('expert multilingual terminologist')) content = '[]'
    else if (prompt.includes('## Here is the input:')) {
      const paragraphs = JSON.parse(prompt.split('## Here is the input:').at(-1).trim())
      content = JSON.stringify(paragraphs.map(paragraph => ({ id: paragraph.id, output: paragraph.input
        .replaceAll('A Bilingual Approach to Scientific Reading', '科学阅读的双语方法（模拟译文）')
        .replaceAll('Scientific translation may improve reading.', '科学翻译可能帮助阅读。')
        .replaceAll('Verify results and conditions.', '请核实结果和条件。')
        .replaceAll('Abstract and Methods', '摘要与方法')
      })))
    }
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, ...(requestCount % 3 ? { prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } : {}) }
    if (holdResponses) { blockedReady?.(); await new Promise(resolve => blockedResponses.push(resolve)) }
    if (response.destroyed) return
    usageHistory.push(usage)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ id: `mock-${requestCount}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }))
  } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: { message: String(error) } })) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const launchEnv = { ...process.env }; delete launchEnv.ELECTRON_RUN_AS_NODE
const packaged = process.env.PAPER_READER_EXECUTABLE
if (packaged) { launchEnv.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`; launchEnv.PYTHONDONTWRITEBYTECODE = '1' }
const launch = (file, profile) => electron.launch({ ...(packaged ? { executablePath: resolve(packaged) } : {}), args: [...(packaged ? [] : ['.']), file, `--data-dir=${resolve(`output/playwright/${packaged ? 'packaged-' : ''}${profile}`)}`], env: launchEnv })
const application = await launch(fixture, 'user-data')
try {
  const page = await application.firstWindow()
  page.on('pageerror', error => console.error('Renderer:', error.message))
  await page.getByRole('button', { name: '翻译全文', exact: true }).waitFor({ timeout: 20000 })
  await page.locator('[data-side="left"] canvas').first().waitFor({ timeout: 20000 })
  assert.match(await page.locator('body').innerText(), /英文 paper.pdf/)
  await page.screenshot({ path: 'output/playwright/reader.png' })
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  await page.getByLabel('服务地址').waitFor()
  await page.screenshot({ path: 'output/playwright/settings.png' })
  await page.getByLabel('服务地址', { exact: true }).fill(baseUrl)
  await page.getByLabel('API 密钥', { exact: true }).fill('smoke-only-api-key')
  await page.getByRole('button', { name: '获取模型', exact: true }).click()
  await page.getByLabel('可用模型', { exact: true }).selectOption(selectedModel)
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByText('连接成功，模型已返回有效回复。').waitFor()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '翻译全文', exact: true }).click()
  try { await page.getByText('全文翻译完成', { exact: true }).waitFor({ timeout: 180000 }) }
  catch (error) {
    const result = await page.evaluate(() => window.reader.currentJob())
    console.error(JSON.stringify(result, null, 2))
    throw error
  }
  await page.locator('[data-side="right"] canvas').first().waitFor()
  await page.locator('[data-side="right"] .textLayer').filter({ hasText: '科学阅读' }).first().waitFor({ timeout: 15000 })
  assert(requestCount > 2, 'real engine must call the mock API')
  await page.getByLabel('英文页码', { exact: true }).fill('2')
  await page.getByLabel('英文页码', { exact: true }).press('Enter')
  await page.waitForFunction(() => document.querySelector('[aria-label="中文页码"]').value === '2')
  await page.getByLabel('英文缩放').selectOption('1.25')
  assert.equal(await page.getByLabel('中文缩放').inputValue(), '1.25')
  await page.getByRole('button', { name: '联动阅读', exact: true }).click()
  await page.getByLabel('英文缩放').selectOption('0.8')
  assert.equal(await page.getByLabel('中文缩放').inputValue(), '1.25')
  await page.getByRole('button', { name: '联动阅读', exact: true }).click()
  await page.getByLabel('英文缩放').selectOption('1')
  await page.getByLabel('英文页码', { exact: true }).fill('1')
  await page.getByLabel('英文页码', { exact: true }).press('Enter')
  await page.screenshot({ path: 'output/playwright/bilingual.png' })
  const result = await page.evaluate(() => window.reader.currentJob())
  const autoSaved = result.value.result.savedTranslationPath
  assert.equal(dirname(autoSaved), dirname(fixture))
  assert.match(basename(autoSaved), /^英文 paper\.中文译文(?: \(\d+\))?\.pdf$/)
  assert.equal((await PDFDocument.load(await readFile(autoSaved))).getPageCount(), 4)
  await page.getByRole('status').filter({ hasText: '中文译文已自动保存至：' }).waitFor()
  assert.equal(result.value.usage.requests, requestCount - 1, 'job counts translation API requests separately from the connection probe')
  assert(result.value.usage.usageReported)
  assert.equal(result.value.usage.promptTokens, result.value.usage.requests * 100)
  assert.equal(result.value.usage.completionTokens, result.value.usage.requests * 50)
  assert(result.value.usage.completionElapsedMs > 0)
  const cacheSamples = usageHistory.slice(1).filter(usage => usage.prompt_cache_hit_tokens !== undefined).length
  assert.equal(result.value.usage.cache.samples, cacheSamples)
  assert.equal(result.value.usage.cache.hitTokens, cacheSamples * 60)
  assert.equal(result.value.usage.cache.missTokens, cacheSamples * 40)
  await page.getByLabel('翻译用量统计', { exact: true }).waitFor()
  assert.match(await page.getByLabel('翻译用量统计', { exact: true }).innerText(), /平均输出 [\d,.]+ token\/s/)
  assert.match(await page.getByLabel('翻译用量统计', { exact: true }).innerText(), /60\.0%/)
  const information = await page.evaluate(() => window.reader.info())
  const diagnosticsDir = join(information.value.dataPath, 'engine-home', 'cache-diagnostics')
  const summary = JSON.parse(await readFile(join(diagnosticsDir, `${result.value.id}.summary.json`), 'utf8'))
  for (const type of ['terminology', 'batch', 'single']) assert(summary.byType[type]?.remoteAttempts > 0, `real engine must exercise ${type}`)
  const rawDiagnostics = await readFile(join(diagnosticsDir, `${result.value.id}.jsonl`), 'utf8')
  assert(!rawDiagnostics.includes('smoke-only-api-key'))
  assert(!rawDiagnostics.includes('Scientific translation may improve reading.'))
  await mkdir('output/cache-optimization-validation', { recursive: true })
  for (const extension of ['jsonl', 'summary.json']) await copyFile(join(diagnosticsDir, `${result.value.id}.${extension}`), `output/cache-optimization-validation/real-engine.${extension}`)
  await writeFile('output/cache-optimization-validation/real-engine-report.json', JSON.stringify({ measurement: 'real BabelDOC engine to local mock API; usage token values synthetic', summary }, null, 2))
  assert(!JSON.stringify(result).includes('smoke-only-api-key'))
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '')
  await page.getByRole('button', { name: '关闭设置' }).click()
  const selectTitle = async side => {
    const span = page.locator(`[data-side="${side}"] [data-page="1"] .textLayer span`).first()
    await span.waitFor()
    await span.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByTestId('selection-toolbar').waitFor()
  }
  await page.locator('[data-side="left"] [data-page="2"] .textLayer span').first().waitFor()
  await page.evaluate(() => {
    const first = document.querySelector('[data-side="left"] [data-page="1"] .textLayer').lastElementChild.firstChild
    const last = document.querySelector('[data-side="left"] [data-page="2"] .textLayer span').firstChild
    const range = document.createRange(); range.setStart(first, 2); range.setEnd(last, 6)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    first.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '黄色高亮', exact: true }).click()
  await waitForBridge(page, async () => {
    const job = await window.reader.currentJob(); const notes = await window.reader.annotations(job.value.documentId)
    return notes.ok && notes.value.some(note => note.anchors.length === 2)
  })
  const crossPage = await page.evaluate(async () => {
    const job = await window.reader.currentJob(); const notes = await window.reader.annotations(job.value.documentId)
    const note = notes.value.find(note => note.anchors.length === 2)
    return note
  })
  assert(crossPage.anchors.every(anchor => anchor.rects.every(rect => rect.height < 0.1 && rect.width * rect.height < 0.1)), 'cross-page selection must only highlight text, never whole pages')
  assert(!/\n1\n/.test(crossPage.quote), 'page captions are not selected PDF text')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByRole('button', { name: '删除批注', exact: true }).click()
  await waitForBridge(page, async () => {
    const job = await window.reader.currentJob(); const notes = await window.reader.annotations(job.value.documentId)
    return notes.ok && !notes.value.some(note => note.anchors.length === 2)
  })
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
  await selectTitle('left')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '添加备注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).fill('重点核对实验条件与结论。')
  await waitForBridge(page, async () => {
    const job = await window.reader.currentJob()
    const notes = await window.reader.annotations(job.value.documentId)
    return notes.ok && notes.value.some(note => note.note === '重点核对实验条件与结论。')
  })
  assert(await page.locator('[data-side="left"] .highlight-mark').count() > 0)
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.pdf-scroll')).every(element => element.scrollWidth === element.clientWidth))
  await page.screenshot({ path: 'output/playwright/bilingual-annotated.png' })
  await page.getByLabel('阅读模式').selectOption('translated')
  await page.locator('[data-side="right"] .textLayer span').first().waitFor()
  assert.equal(await page.locator('[data-side="left"]').count(), 0)
  await selectTitle('right')
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '绿色高亮', exact: true }).click()
  await waitForBridge(page, async () => {
    const job = await window.reader.currentJob(); const notes = await window.reader.annotations(job.value.documentId)
    return notes.ok && notes.value.some(note => note.sourceKey.startsWith('translated:') && note.color === 'green')
  })
  const exported = resolve('output/playwright/中文论文.pdf')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, exported)
  await page.getByRole('button', { name: '另存译文', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '中文译文已保存至' }).waitFor()
  assert.equal((await PDFDocument.load(await readFile(exported))).getPageCount(), 4)
  assert.deepEqual(await readFile(exported), await readFile(autoSaved))
  await page.getByLabel('中文页码', { exact: true }).fill('3')
  await page.getByLabel('中文页码', { exact: true }).press('Enter')
  await page.getByLabel('阅读模式').selectOption('parallel')
  await page.waitForFunction(() => ['英文', '中文'].every(language => document.querySelector(`[aria-label="${language}页码"]`)?.value === '3'))
  await page.getByLabel('阅读模式').selectOption('original')
  await page.getByLabel('英文页码', { exact: true }).fill('2')
  await page.getByLabel('英文页码', { exact: true }).press('Enter')
  console.log(`UI passed: real engine + mock API (${requestCount} requests), bilingual rendering, linked pages/zoom, independent zoom, encrypted settings, selection highlights/notes, Chinese-only view, translated export.`)
  const cancellation = await PDFDocument.create(); const [firstPage] = await cancellation.copyPages(pdf, [0]); cancellation.addPage(firstPage); cancellation.setTitle('Cancellation cache integration fixture')
  const cancelFixture = resolve('output/playwright/cache-cancel-fixture.pdf'); await writeFile(cancelFixture, await cancellation.save())
  holdResponses = true
  const blocked = new Promise(resolve => { blockedReady = resolve })
  const started = await page.evaluate(async path => { const doc = await window.reader.openPdf(path); if (!doc.ok) throw new Error(doc.error); return window.reader.startTranslation(doc.value.id) }, cancelFixture)
  let timer
  try { await Promise.race([blocked, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('real engine did not reach blocked upstream')), 60000) })]) } finally { clearTimeout(timer) }
  await page.evaluate(id => window.reader.cancelTranslation(id), started.value.id)
  assert.equal((await page.evaluate(() => window.reader.currentJob())).value.status, 'cancelled')
  holdResponses = false; for (const release of blockedResponses.splice(0)) release()
  await page.evaluate(id => window.reader.startTranslation(id), started.value.documentId)
  await waitForBridge(page, async () => (await window.reader.currentJob()).value?.status !== 'running', 180000)
  assert.equal((await page.evaluate(() => window.reader.currentJob())).value.status, 'completed')
  console.log('Cache integration passed: three real templates, weighted H/M coverage, private diagnostics, actual engine cancellation and retry.')
} finally { holdResponses = false; for (const release of blockedResponses.splice(0)) release(); await application.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }

const restarted = await launch(fixture, 'user-data')
try {
  const page = await restarted.firstWindow()
  await page.getByLabel('英文页码', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="英文页码"]').value === '2')
  assert.equal(await page.getByLabel('阅读模式').inputValue(), 'original')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(element => element.value === '重点核对实验条件与结论。'))
  const beforeCache = requestCount
  await page.getByRole('button', { name: '翻译全文', exact: true }).click()
  await page.getByText('已载入本地译文', { exact: true }).waitFor()
  assert.equal(requestCount, beforeCache, 'full PDF reuse after restart must not make an upstream call')
  console.log('Restart passed: reading mode, last page, highlights and Chinese note restored.')
} finally { await restarted.close() }

const chinese = await launch(resolve('output/playwright/中文论文.pdf'), 'chinese-user-data')
try {
  const page = await chinese.firstWindow()
  await page.locator('[data-side="left"] .textLayer span').first().waitFor({ timeout: 30000 })
  assert.equal(await page.getByLabel('阅读模式').inputValue(), 'original')
  assert.equal(await page.locator('[data-side="right"]').count(), 0)
  assert.equal(await page.getByRole('button', { name: '翻译全文', exact: true }).count(), 0)
  const config = await page.evaluate(() => window.reader.settings())
  assert.equal(config.value.hasApiKey, false)
  const span = page.locator('[data-side="left"] [data-page="1"] .textLayer span').first()
  await span.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '添加备注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).fill('中文论文也可以直接阅读与批注。')
  await page.screenshot({ path: 'output/playwright/chinese-reader.png' })
  console.log('Chinese reader passed: no API configured, automatic single-pane Chinese reading, selection highlight + note.')
} finally { await chinese.close() }
