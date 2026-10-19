import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts, PDFHexString, degrees } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const directory = resolve('output/playwright', process.env.PAPER_READER_EXECUTABLE ? 'packaged-reader-selection-64mib' : 'reader-selection-64mib')
await mkdir(directory, { recursive: true })
async function fixture(label, modified) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
  for (let i = 0; i < 300; i++) {
    const page = pdf.addPage([595, 842]); page.setRotation(degrees([0, 90, 180, 270][i % 4]))
    page.drawText(`${label} document page ${i + 1}`, { x: 40, y: 780, size: 16, font })
    for (let line = 0; line < 30; line++) page.drawText(`Line ${line + 1}: scientific evidence, conditions and selection remain aligned.`, { x: 40, y: 740 - line * 20, size: 10, font })
  }
  pdf.context.trailerInfo.ID = pdf.context.obj([PDFHexString.of('0102030405060708090a0b0c0d0e0f10'), PDFHexString.of(modified)])
  return pdf.save()
}
const original = resolve(directory, 'original.pdf'); const translated = resolve(directory, 'translated.pdf')
await writeFile(original, await fixture('Original', '1112131415161718191a1b1c1d1e1f20'))
await writeFile(translated, await fixture('Translated', '2122232425262728292a2b2c2d2e2f30'))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), original, '--force-device-scale-factor=2', `--data-dir=${resolve(directory, `data-${Date.now()}`)}`], env })
const checks = []; let page; const errors = []
const check = (name, details = {}) => { checks.push({ name, passed: true, ...details }); console.log(name) }
try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.setBackgroundThrottling(false)))
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  const firstText = '[data-side="left"] [data-page="1"] .textLayer span'
  await page.locator(firstText).first().waitFor({ timeout: 30000 })
  await app.browserWindow(page).then(window => window.evaluate(window => window.setContentSize(1400, 900)))
  const url = new URL(page.url()); url.searchParams.set('pdf-cache-mib', '64')
  await page.goto(url.href); await page.locator(firstText).first().waitFor({ timeout: 30000 })
  assert(Math.abs(await page.evaluate(() => devicePixelRatio) - 2) < 1e-6, 'selection fixture must retain actual DPR 2')
  await page.getByRole('button', { name: '导入中英对照', exact: true }).click()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, translated)
  await page.getByRole('dialog').getByRole('button', { name: '选择中文 PDF', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.locator('[data-side="right"] .textLayer span').first().waitFor({ timeout: 30000 })
  assert.match(await page.locator(firstText).first().innerText(), /Original/)
  assert.match(await page.locator('[data-side="right"] [data-page="1"] .textLayer span').first().innerText(), /Translated/)
  check('相同原始 PDF 指纹的原译文文字缓存隔离')
  const jump = async number => {
    await page.getByLabel('英文页码', { exact: true }).fill(String(number)); await page.getByLabel('英文页码', { exact: true }).press('Enter')
    await page.locator(`[data-side="left"] [data-page="${number}"] .textLayer span`).first().waitFor({ timeout: 15000 })
  }
  for (let number = 1; number <= 4; number++) {
    await jump(number)
    const result = await page.locator(`[data-side="left"] [data-page="${number}"]`).evaluate(slot => {
      const paper = slot.querySelector('.pdf-paper').getBoundingClientRect(); const layer = slot.querySelector('.textLayer'); const span = layer.querySelector('span'); const text = span.getBoundingClientRect()
      return { rotation: layer.dataset.mainRotation, paper: { left: paper.left, top: paper.top, right: paper.right, bottom: paper.bottom }, text: { left: text.left, top: text.top, right: text.right, bottom: text.bottom }, transform: getComputedStyle(layer).transform }
    })
    assert.equal(Number(result.rotation), [0, 90, 180, 270][number - 1])
    assert(result.text.left >= result.paper.left - 2 && result.text.top >= result.paper.top - 2 && result.text.right <= result.paper.right + 2 && result.text.bottom <= result.paper.bottom + 2, `rotated text must stay aligned: ${JSON.stringify(result)}`)
    check(`旋转 ${result.rotation} 度文字层边界`, result)
  }
  await page.getByLabel('英文缩放').selectOption('0.5'); await jump(1)
  await page.locator('[data-side="left"] [data-page="2"] .textLayer span').first().waitFor()
  const quote = await page.evaluate(() => {
    document.querySelector('[data-side="left"] .pdf-scroll').focus({ preventScroll: true })
    const first = document.querySelector('[data-side="left"] [data-page="1"] .textLayer span').firstChild
    const second = document.querySelector('[data-side="left"] [data-page="2"] .textLayer span').firstChild
    const range = document.createRange(); range.setStart(first, 0); range.setEnd(second, Math.min(20, second.length))
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    window.selectionAnchor = first
    window.selectionEnd = second
    return selection.toString()
  })
  assert(quote.length > 100)
  const budgets = []
  for (const number of [60, 120, 180, 240, 290, 30]) {
    await page.locator('[data-side="left"] .pdf-scroll').evaluate((root, number) => { root.scrollTop = root.querySelector(`[data-page="${number}"]`).offsetTop }, number)
    await page.locator(`[data-side="left"] [data-page="${number}"] .textLayer span`).first().waitFor({ timeout: 15000 })
    const snapshot = await page.evaluate(() => ({ preserved: getSelection().toString(), connected: window.selectionAnchor.isConnected, endConnected: window.selectionEnd.isConnected, active: document.activeElement.className, anchor: getSelection().anchorNode?.parentElement?.outerHTML.slice(0, 250), stats: window.__pdfPerformance }))
    assert(snapshot.preserved === quote, JSON.stringify({ number, selectedLength: snapshot.preserved.length, expectedLength: quote.length, ...snapshot, preserved: undefined }))
    assert(snapshot.connected)
    assert(snapshot.stats.rasterBytes <= 64 * 1024 * 1024); budgets.push(snapshot.stats.rasterBytes)
  }
  check('跨页选区经历 300 页缓存压力与往返仍保留', { maxRasterBytes: Math.max(...budgets) })
  await page.locator('[data-side="left"] .pdf-scroll').evaluate(root => { root.scrollTop = 0 })
  await page.getByLabel('英文缩放').selectOption('1.25')
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => getSelection().toString()), quote)
  assert(await page.evaluate(() => window.selectionAnchor.isConnected))
  check('活动跨页选区在缩放后保留原文字节点')
  await page.evaluate(() => getSelection().removeAllRanges())
  await page.waitForFunction(() => document.querySelector('[data-side="left"] [data-page="1"] .textLayer').style.scale === '')
  check('清除选区后恢复精确文字层')
  for (const zoom of ['3', '2.5', '3', '1', '3']) {
    await page.getByLabel('英文缩放').selectOption(zoom)
    await page.waitForFunction(() => {
      const slot = document.querySelector('[data-side="left"] [data-page="1"]')
      const layer = slot.querySelector('.textLayer')
      return slot.querySelector('canvas')?.dataset.quality === 'clear' && Math.abs(parseFloat(layer.style.getPropertyValue('--total-scale-factor')) - parseFloat(slot.style.width) / 595) < .001
    }, undefined, { timeout: 15000 })
    const stats = await page.evaluate(() => window.__pdfPerformance)
    assert(stats.rasterBytes <= 64 * 1024 * 1024)
    assert(await page.locator('canvas').evaluateAll(canvases => canvases.every(canvas => canvas.width * canvas.height <= 8_000_000)))
  }
  check('DPR 2 与 300% 连续缩放不超 64 MiB 缓存预算且绘制可继续')
  await page.getByLabel('英文缩放').selectOption('1'); await jump(1)
  for (const side of ['left', 'right']) {
    await page.waitForFunction(side => {
      const slot = document.querySelector(`[data-side="${side}"] [data-page="1"]`)
      return Math.abs(parseFloat(slot.querySelector('.textLayer').style.getPropertyValue('--total-scale-factor')) - parseFloat(slot.style.width) / 595) < .001
    }, side, { timeout: 15000 })
    const span = page.locator(`[data-side="${side}"] [data-page="1"] .textLayer span`).first(); const box = await span.boundingBox()
    if (side === 'right') {
      await page.mouse.move(box.x + 3, box.y + box.height / 2); await page.mouse.down()
      await page.mouse.move(box.x + Math.min(150, box.width - 2), box.y + box.height / 2, { steps: 12 }); await page.mouse.up()
      assert((await page.evaluate(() => getSelection().toString())).length > 3)
      check('译文栏普通鼠标拖选')
      await page.getByRole('button', { name: '取消选中', exact: true }).click()
    }
    await page.mouse.move(box.x + 3, box.y + box.height / 2); await page.mouse.down()
    await page.evaluate(() => { window.dragAnchor = getSelection().anchorNode; window.dragOffset = getSelection().anchorOffset })
    await page.locator('.reading-workspace').evaluate((workspace, side) => { workspace.style.gridTemplateColumns = side === 'left' ? 'minmax(0, 45fr) 8px minmax(0, 55fr)' : 'minmax(0, 55fr) 8px minmax(0, 45fr)' }, side)
    await page.waitForTimeout(500)
    assert(await page.evaluate(() => window.dragAnchor?.isConnected), 'collapsed drag anchor must remain connected during resize')
    const moved = await span.boundingBox()
    const layerState = await span.evaluate(element => ({ layer: element.parentElement.style.cssText, parent: element.closest('.pdf-paper').getBoundingClientRect().toJSON(), offset: getSelection().anchorOffset, connected: window.dragAnchor.isConnected }))
    await page.mouse.move(moved.x + Math.min(150, moved.width - 2), moved.y + moved.height / 2, { steps: 12 }); await page.mouse.up()
    const quote = await page.evaluate(() => getSelection().toString())
    assert(quote.length > 3, JSON.stringify({ side, box, moved, layerState }))
    assert(await page.evaluate(() => getSelection().anchorNode === window.dragAnchor && getSelection().anchorOffset === window.dragOffset), 'drag must extend from the original DOM caret')
    assert.match(quote, side === 'left' ? /^Original/ : /^Translated/)
    check(`${side === 'left' ? '原文' : '译文'}真实鼠标拖选起点在栏宽变化期间保留`)
    await page.getByRole('button', { name: '黄色高亮', exact: true }).click()
    await page.locator(`[data-side="${side}"] [data-page="1"] .highlight-mark`).first().waitFor()
    check(`${side === 'left' ? '原文' : '译文'}拖选结果可保存为位置正确的批注`)
  }
  await page.locator('.reading-workspace').evaluate(workspace => { workspace.style.gridTemplateColumns = 'minmax(0, 45fr) 8px minmax(0, 55fr)' })
  await page.waitForTimeout(500)
  const words = await page.locator('[data-side="right"] [data-page="1"] .textLayer span').nth(1).evaluate(span => {
    const node = span.firstChild; const start = node.textContent.indexOf('scientific')
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'scientific'.length)
    return range.getBoundingClientRect().toJSON()
  })
  await page.mouse.click(words.x + words.width / 2, words.y + words.height / 2)
  await page.mouse.down({ clickCount: 2 })
  assert.equal((await page.evaluate(() => getSelection().toString())).trim(), 'scientific')
  await page.locator('.reading-workspace').evaluate(workspace => { workspace.style.gridTemplateColumns = 'minmax(0, 55fr) 8px minmax(0, 45fr)' })
  await page.waitForTimeout(500)
  const destination = await page.locator('[data-side="right"] [data-page="1"] .textLayer span').nth(1).boundingBox()
  await page.mouse.move(destination.x + destination.width - 3, destination.y + destination.height / 2, { steps: 12 }); await page.mouse.up()
  assert.match((await page.evaluate(() => getSelection().toString())).trim(), /^scientific\b/, 'double-click word selection must retain the complete starting word after pane relocation')
  check('译文栏双击选词后拖选在栏宽变化期间保留完整词首')
  await page.screenshot({ path: resolve(directory, 'selection-annotated.png') })
  assert.deepEqual(errors, [])
  const resources = await page.evaluate(() => window.__pdfPerformance)
  const actualDpr = await page.evaluate(() => devicePixelRatio)
  assert(Math.abs(actualDpr - 2) < 1e-6, 'selection fixture DPR must remain active through all checks')
  await writeFile(resolve(directory, 'result.json'), JSON.stringify({ passed: true, actualDpr, checks, resources, errors }, null, 2))
} catch (error) {
  await page?.screenshot({ path: resolve(directory, 'failure.png') }).catch(() => {})
  await writeFile(resolve(directory, 'result.json'), JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2))
  throw error
} finally { await app.close() }
