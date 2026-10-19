import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(`output/playwright/pair-${Date.now()}`)
await mkdir(root, { recursive: true })
async function fixture(name, title, pages) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= pages; index++) {
    const page = pdf.addPage([595, 842])
    page.drawText(title, { font, x: 45, y: 770, size: 18 })
    page.drawText(`Page ${index}: a local PDF for paired reading and annotations.`, { font, x: 45, y: 700, size: 12 })
  }
  const path = join(root, name); await writeFile(path, await pdf.save()); return path
}
const original = await fixture('英文 original.pdf', 'Original English paper', 3)
const translated = await fixture('中文 version.pdf', 'Imported Chinese version (test fixture)', 3)
const different = await fixture('中文 different.pdf', 'Another version with different pagination', 2)
const invalid = join(root, '损坏.pdf'); await writeFile(invalid, '%PDF-invalid')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const launch = (file) => electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), ...(file ? [file] : []), `--data-dir=${join(root, 'data')}`], env })
async function choose(app, page, name, path) {
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, path)
  await page.getByRole('button', { name, exact: true }).click()
}
async function openPair(app, page, rightPath) {
  await page.getByRole('button', { name: '导入中英对照', exact: true }).first().click()
  await page.getByRole('dialog', { name: '导入中英对照' }).waitFor()
  await choose(app, page, '选择英文 PDF', original)
  await choose(app, page, '选择中文 PDF', rightPath)
  await page.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.locator('[data-side="right"] .textLayer span').first().waitFor()
}
async function ctrlWheel(page, side, delta, leftZoom, rightZoom) {
  await page.locator(`[data-side="${side}"] .pdf-scroll`).hover()
  await page.keyboard.down('Control')
  try { await page.mouse.wheel(0, delta) } finally { await page.keyboard.up('Control') }
  await page.waitForFunction(({ leftZoom, rightZoom }) => document.querySelector('[aria-label="英文缩放"]').value === leftZoom && document.querySelector('[aria-label="中文缩放"]').value === rightZoom, { leftZoom, rightZoom }, { timeout: 5000 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
const app = await launch()
try {
  const page = await app.firstWindow()
  page.on('pageerror', error => { throw error })
  await page.getByRole('button', { name: '导入中英对照', exact: true }).first().waitFor({ timeout: 5000 })
  await openPair(app, page, translated)
  assert.equal((await page.evaluate(() => window.reader.settings())).value.hasApiKey, false)
  assert.equal((await page.evaluate(() => window.reader.currentJob())).value, null)
  await page.getByLabel('英文页码', { exact: true }).fill('2'); await page.getByLabel('英文页码', { exact: true }).press('Enter')
  await page.waitForFunction(() => document.querySelector('[aria-label="中文页码"]').value === '2')
  await page.getByLabel('英文缩放').selectOption('1.25')
  assert.equal(await page.getByLabel('中文缩放').inputValue(), '1.25')
  const widthBeforeZoom = await page.locator('[data-side="left"] .pdf-paper').first().evaluate(element => element.getBoundingClientRect().width)
  await ctrlWheel(page, 'left', -120, '1.5', '1.5')
  assert(await page.locator('[data-side="left"] .pdf-paper').first().evaluate(element => element.getBoundingClientRect().width) > widthBeforeZoom, 'Ctrl + wheel must enlarge the PDF itself')
  assert.equal(await page.getByLabel('英文页码', { exact: true }).inputValue(), '2')
  await ctrlWheel(page, 'right', 120, '1.25', '1.25')
  assert.equal(await page.getByLabel('中文页码', { exact: true }).inputValue(), '2')
  const scrollBeforeWheel = await page.locator('[data-side="right"] .pdf-scroll').evaluate(element => element.scrollTop)
  await page.mouse.wheel(0, 120)
  await page.waitForFunction(top => document.querySelector('[data-side="right"] .pdf-scroll').scrollTop > top, scrollBeforeWheel)
  assert.equal(await page.getByLabel('中文缩放').inputValue(), '1.25', 'ordinary wheel must scroll without changing zoom')
  for (const [value, delta] of [['0.5', 120], ['3', -120]]) {
    await page.getByLabel('英文缩放').selectOption(value)
    await ctrlWheel(page, 'left', delta, value, value)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1, 'Ctrl + wheel must not zoom the entire application, including at PDF zoom limits')
    assert.equal(await page.locator('[data-side="left"] .pdf-scroll').evaluate((element, deltaY) => element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY, bubbles: true, cancelable: true })), delta), false, 'Ctrl + wheel must cancel browser zoom even at the limit')
  }
  await page.getByRole('button', { name: '联动阅读', exact: true }).click()
  await page.getByLabel('英文缩放').selectOption('1')
  await page.getByLabel('中文缩放').selectOption('1.25')
  await ctrlWheel(page, 'right', -120, '1', '1.5')
  await ctrlWheel(page, 'left', 120, '0.8', '1.5')
  await page.locator('[data-side="left"] .pdf-scroll').evaluate(element => {
    for (let i = 0; i < 3; i++) element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('[aria-label="英文缩放"]').value === '1.5')
  assert.equal(await page.getByLabel('英文缩放').inputValue(), '1.5', 'consecutive wheel events must use the latest zoom')
  await page.getByRole('button', { name: '联动阅读', exact: true }).click()
  await page.getByLabel('英文缩放').selectOption('1.25')
  await page.getByLabel('英文页码', { exact: true }).fill('2'); await page.getByLabel('英文页码', { exact: true }).press('Enter')
  console.log('Ctrl + wheel passed: PDF rendering, linked and independent zoom, reading page, normal scroll, bounds and consecutive events.')
  const span = page.locator('[data-side="right"] [data-page="2"] .textLayer span').first()
  await span.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '添加备注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).fill('导入中文版本的本地批注。')
  await page.getByRole('button', { name: '关闭批注侧栏' }).click()
  await page.screenshot({ path: join(root, 'paired-reader.png') })
  await page.getByRole('button', { name: '导入中英对照', exact: true }).first().click()
  await choose(app, page, '选择中文 PDF', invalid)
  await page.getByRole('alert').waitFor()
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').contains(document.activeElement))
  await page.getByRole('button', { name: '取消', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert(await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)))
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '导入中英对照')
  assert.equal(await page.getByLabel('中文页码', { exact: true }).inputValue(), '2')
  await openPair(app, page, different)
  assert(await page.getByRole('button', { name: '联动阅读', exact: true }).isDisabled())
  await page.getByRole('status').filter({ hasText: '页数不同' }).waitFor()
  assert.equal(await page.locator('[data-side="right"] .highlight-mark').count(), 0)
  // Dragging two PDFs opens the same assignment dialog, and cancellation preserves the reader.
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'drop-fixture'; input.hidden = true; document.body.append(input) })
  await page.locator('#drop-fixture').setInputFiles([original, translated])
  await page.locator('#drop-fixture').evaluate(element => {
    const transfer = new DataTransfer(); for (const file of element.files) transfer.items.add(file)
    document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    element.remove()
  })
  await page.getByRole('dialog', { name: '导入中英对照' }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[aria-label="交换左右文件"]').disabled)
  await page.getByRole('button', { name: '交换左右文件', exact: true }).click()
  await page.getByRole('button', { name: '交换左右文件', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.screenshot({ path: join(root, 'import-small.png') })
  await page.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.locator('[data-side="right"] .textLayer span').first().waitFor()
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '导入中文版本的本地批注。')
  await page.getByRole('button', { name: '关闭批注侧栏' }).click()
  await page.screenshot({ path: join(root, 'reader-small.png') })
  await page.getByLabel('英文缩放').selectOption('1')
  await ctrlWheel(page, 'left', -120, '1.25', '1.25')
  console.log(`Pair UI passed: offline import, linked pages/zoom, annotations, invalid input, unequal pages, two-file drop, swap; screenshots: ${root}`)
} finally { await app.close() }
await rename(translated, join(root, 'moved-source.pdf'))
const restarted = await launch(original)
try {
  const page = await restarted.firstWindow()
  await page.locator('[data-side="right"] .textLayer span').first().waitFor({ timeout: 20000 })
  assert.equal((await page.evaluate(() => window.reader.settings())).value.hasApiKey, false)
  assert.equal(await page.getByLabel('阅读模式').inputValue(), 'parallel')
  assert.equal(await page.getByLabel('英文缩放').inputValue(), '1.25', 'wheel zoom must survive restarting the reader')
  assert.equal(await page.getByLabel('中文缩放').inputValue(), '1.25')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '导入中文版本的本地批注。')
  console.log('Pair restart passed: stored PDF snapshot, pair, reading mode and annotation restored without an API key.')
} finally { await restarted.close() }
