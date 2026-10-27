import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(`output/playwright/documents-${Date.now()}`)
await mkdir(root, { recursive: true })
async function fixture(name, title) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
  for (let n = 1; n <= 8; n++) {
    const sheet = pdf.addPage([600, 800])
    for (let line = 0; line < 28; line++) sheet.drawText(`${title}. Page ${n}, line ${line + 1}: independent reading and annotation.`, { x: 40, y: 740 - line * 22, size: 12, font })
  }
  const path = join(root, name); await writeFile(path, await pdf.save()); return path
}
const first = await fixture('第一篇-控制方法研究.pdf', 'First paper')
const second = await fixture('第二篇-自适应控制综述.pdf', 'Second paper')
const translated = await fixture('第一篇-中文对照.pdf', 'Translated first paper')
const invalid = join(root, '损坏.pdf'); await writeFile(invalid, '%PDF-invalid')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const launch = file => electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), ...(file ? [file] : []), `--data-dir=${join(root, 'data')}`], env })
async function drop(page, path) {
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'document-drop'; input.hidden = true; document.body.append(input) })
  await page.locator('#document-drop').setInputFiles(path)
  await page.locator('#document-drop').evaluate(input => {
    const transfer = new DataTransfer(); for (const file of input.files) transfer.items.add(file)
    document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); input.remove()
  })
}
const paperButton = (page, name) => page.getByRole('button', { name: `切换到论文：${name}`, exact: true })
async function ready(page, name) {
  await page.waitForFunction(name => document.querySelector('.document-title')?.textContent.includes(name) && !document.querySelector('.document-bar .primary')?.disabled, name, { timeout: 30000 })
  await page.locator('[data-side="left"] .textLayer span').first().waitFor()
}
async function go(page, number) {
  await page.getByLabel('左侧页码', { exact: true }).fill(String(number)); await page.getByLabel('左侧页码', { exact: true }).press('Enter')
  await page.locator(`[data-side="left"] [data-page="${number}"] .textLayer span`).first().waitFor()
}
async function addNote(page, number, text) {
  await page.locator(`[data-side="left"] [data-page="${number}"] .textLayer span`).first().evaluate(span => {
    const range = document.createRange(); range.selectNodeContents(span)
    getSelection().removeAllRanges(); getSelection().addRange(range); span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '添加备注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).fill(text)
}
const app = await launch()
let page
const errors = []
try {
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button', { name: '打开论文' }).waitFor()
  await drop(page, first); await ready(page, '第一篇-控制方法研究.pdf')
  await page.getByRole('button', { name: '展开论文列表', exact: true }).click({ timeout: 5000 })
  assert.equal(await paperButton(page, '第一篇-控制方法研究.pdf').count(), 1)
  await page.getByLabel('阅读模式').selectOption('original')
  await go(page, 3); await page.getByLabel('左侧缩放').selectOption('1.25')
  await addNote(page, 3, '第一篇独立备注')
  await drop(page, second); await ready(page, '第二篇-自适应控制综述.pdf')
  assert.equal(await page.locator('.document-list-item').count(), 2, 'consecutive drops must append papers')
  await page.getByLabel('阅读模式').selectOption('original'); await go(page, 5)
  await page.getByLabel('左侧缩放').selectOption('0.8')
  await addNote(page, 5, '第二篇独立备注')
  await paperButton(page, '第一篇-控制方法研究.pdf').click(); await ready(page, '第一篇-控制方法研究.pdf')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '3')
  assert.equal(await page.getByLabel('左侧缩放').inputValue(), '1.25')
  assert.equal(await page.getByLabel('阅读模式').inputValue(), 'original')
  await page.getByLabel('批注备注', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '第一篇独立备注')
  await paperButton(page, '第二篇-自适应控制综述.pdf').click(); await ready(page, '第二篇-自适应控制综述.pdf')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '5')
  assert.equal(await page.getByLabel('左侧缩放').inputValue(), '0.8')
  await page.getByLabel('批注备注', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '第二篇独立备注')
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
  await page.screenshot({ path: join(root, 'expanded.png') })
  await page.getByRole('button', { name: '收起论文列表', exact: true }).first().click()
  assert.equal(await page.getByRole('complementary', { name: '已打开的论文' }).isVisible(), false)
  await page.screenshot({ path: join(root, 'collapsed.png') })
  await page.getByRole('button', { name: '展开论文列表', exact: true }).click()
  await drop(page, first); await ready(page, '第一篇-控制方法研究.pdf')
  assert.equal(await page.locator('.document-list-item').count(), 2, 'reopening the same content must not duplicate it')
  await drop(page, invalid)
  await page.getByRole('status').filter({ hasText: /无效|损坏|Invalid|PDF/i }).waitFor()
  assert.equal(await page.locator('.document-list-item').count(), 2, 'an invalid file must preserve existing papers')
  assert((await page.locator('.document-title').textContent()).includes('第一篇-控制方法研究.pdf'))
  // A paired original and translation remain one list entry and keep independent positions.
  await page.getByRole('button', { name: '导入对照论文', exact: true }).first().click()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, translated)
  await page.getByRole('button', { name: '选择右侧 PDF', exact: true }).click()
  await page.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await ready(page, '第一篇-控制方法研究.pdf')
  await page.locator('[data-side="right"] .textLayer span').first().waitFor()
  assert.equal(await page.locator('.document-list-item').count(), 2)
  await page.getByRole('button', { name: '联动阅读', exact: true }).click()
  await page.getByLabel('右侧缩放').selectOption('0.8')
  await page.getByLabel('右侧页码', { exact: true }).fill('6'); await page.getByLabel('右侧页码', { exact: true }).press('Enter')
  await page.locator('[data-side="right"] [data-page="6"] .textLayer span').first().waitFor()
  await page.locator('[data-side="right"] .pdf-scroll').evaluate(element => {
    const slot = element.querySelector('[data-page="6"]')
    element.scrollTop += slot.getBoundingClientRect().top - element.getBoundingClientRect().top + slot.getBoundingClientRect().height * .27
  })
  await page.waitForTimeout(400)
  const rightTop = await page.locator('[data-side="right"] .pdf-scroll').evaluate(element => element.scrollTop)
  await paperButton(page, '第二篇-自适应控制综述.pdf').click(); await ready(page, '第二篇-自适应控制综述.pdf')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '5')
  await paperButton(page, '第一篇-控制方法研究.pdf').click(); await ready(page, '第一篇-控制方法研究.pdf')
  await page.locator('[data-side="right"] [data-page="6"] .textLayer span').first().waitFor()
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '3')
  assert.equal(await page.getByLabel('右侧页码', { exact: true }).inputValue(), '6')
  assert.equal(await page.getByLabel('右侧缩放').inputValue(), '0.8')
  assert(Math.abs(await page.locator('[data-side="right"] .pdf-scroll').evaluate(element => element.scrollTop) - rightTop) < 3, 'page-internal scroll position must survive switching')
  await page.screenshot({ path: join(root, 'paired-expanded.png') })
  // A reader can still move while the previous position is being saved.
  await page.waitForTimeout(400)
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('reader:save-reading'); let slow = true
    ipcMain.removeHandler('reader:save-reading')
    ipcMain.handle('reader:save-reading', async (...args) => {
      if (!slow) return handler(...args)
      slow = false; globalThis.__documentSavePending = true
      const result = await handler(...args); await new Promise(resolve => setTimeout(resolve, 200))
      globalThis.__documentSavePending = false; return result
    })
  })
  await paperButton(page, '第二篇-自适应控制综述.pdf').click()
  await app.evaluate(async () => {
    const deadline = Date.now() + 3000
    while (!globalThis.__documentSavePending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (!globalThis.__documentSavePending) throw new Error('Expected an in-progress reading save')
  })
  await page.getByLabel('左侧页码', { exact: true }).fill('4'); await page.getByLabel('左侧页码', { exact: true }).press('Enter')
  await ready(page, '第二篇-自适应控制综述.pdf')
  await paperButton(page, '第一篇-控制方法研究.pdf').click(); await ready(page, '第一篇-控制方法研究.pdf')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '4', 'reading changes made during an awaited save must survive switching')
  await go(page, 3)
  // Failure to persist reading must keep the current paper visible and allow retry.
  await page.waitForTimeout(400)
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('reader:save-reading'); let fail = true
    ipcMain.removeHandler('reader:save-reading')
    ipcMain.handle('reader:save-reading', (...args) => {
      if (fail) { fail = false; return { ok: false, error: '验收：阅读记录暂时无法保存，请重试。' } }
      return handler(...args)
    })
  })
  await paperButton(page, '第二篇-自适应控制综述.pdf').click()
  await page.getByRole('status').filter({ hasText: '阅读记录暂时无法保存' }).waitFor()
  assert((await page.locator('.document-title').textContent()).includes('第一篇-控制方法研究.pdf'), 'failed saves must prevent losing the current paper')
  assert.equal(await page.locator('.document-list-item').count(), 2)
  await paperButton(page, '第二篇-自适应控制综述.pdf').click(); await ready(page, '第二篇-自适应控制综述.pdf')
  await paperButton(page, '第一篇-控制方法研究.pdf').click(); await ready(page, '第一篇-控制方法研究.pdf')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.screenshot({ path: join(root, 'minimum.png') })
  const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.querySelector('.app-shell').scrollWidth, pane: document.querySelector('.reading-workspace').getBoundingClientRect().width }))
  assert(layout.width <= layout.viewport + 1 && layout.pane > 400, `minimum window must retain usable reading space: ${JSON.stringify(layout)}`)
  await page.getByRole('button', { name: '关闭论文：第一篇-控制方法研究.pdf', exact: true }).click()
  await ready(page, '第二篇-自适应控制综述.pdf')
  assert.equal(await page.locator('.document-list-item').count(), 1)
  await page.getByRole('button', { name: '关闭论文：第二篇-自适应控制综述.pdf', exact: true }).click()
  await page.locator('.welcome').waitFor()
  // Slow the real IPC response to prove a second drop during opening is queued.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('reader:open-pdf')
    ipcMain.removeHandler('reader:open-pdf')
    ipcMain.handle('reader:open-pdf', async (...args) => { const result = await handler(...args); await new Promise(resolve => setTimeout(resolve, 350)); return result })
  })
  await drop(page, first); await drop(page, second); await ready(page, '第二篇-自适应控制综述.pdf')
  if (await page.getByRole('button', { name: '展开论文列表', exact: true }).count()) await page.getByRole('button', { name: '展开论文列表', exact: true }).click()
  assert.equal(await page.locator('.document-list-item').count(), 2, 'drops while an earlier open is pending must not be ignored')
  await paperButton(page, '第一篇-控制方法研究.pdf').click(); await ready(page, '第一篇-控制方法研究.pdf')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '3', 'closing and reopening must retain progress')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '第一篇独立备注')
  assert.deepEqual(errors, [])
} catch (error) {
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
const restarted = await launch(second)
try {
  const page = await restarted.firstWindow(); await ready(page, '第二篇-自适应控制综述.pdf')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '5')
  assert.equal(await page.getByLabel('左侧缩放').inputValue(), '0.8')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '第二篇独立备注')
} finally { await restarted.close() }
console.log(`Documents passed: drop queue, switching, independent pages/zoom/notes, collapse, duplicate/error handling, close/reopen and restart. Screenshots: ${root}`)
