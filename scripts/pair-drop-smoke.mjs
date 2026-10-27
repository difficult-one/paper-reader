import { _electron as electron } from 'playwright'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(`output/playwright/pair-drop-${Date.now()}`)
await mkdir(root, { recursive: true })
async function fixture(name, title, count = 4) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
  for (let n = 1; n <= count; n++) {
    const page = pdf.addPage([600, 800])
    for (let line = 0; line < 26; line++) page.drawText(`${title}. Page ${n}, line ${line + 1}. Direct drop for paired reading.`, { x: 40, y: 740 - line * 22, size: 12, font })
  }
  const path = join(root, name); await writeFile(path, await pdf.save()); return path
}
const original = await fixture('英文原文.pdf', 'Original English paper')
const translated = await fixture('中文版本.pdf', 'Chinese version test fixture')
const replacement = await fixture('另一个中文版本.pdf', 'Replacement Chinese version', 3)
const separate = await fixture('独立论文.pdf', 'Independent paper')
const queuedLeft = await fixture('连续拖入-左侧.pdf', 'Queued left paper')
const queuedRight = await fixture('连续拖入-右侧.pdf', 'Queued right paper')
async function chineseFixture(name, text) {
  const pdf = await PDFDocument.create()
  const cid = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'STSong-Light', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 4 } }))
  const font = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light', Encoding: 'UniGB-UCS2-H', DescendantFonts: [cid] }))
  for (let n = 1; n <= 3; n++) {
    const sheet = pdf.addPage([600, 800]); sheet.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font } }))
    const content = Array.from(text + `第${n}页。`).map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    sheet.node.addContentStream(pdf.context.register(pdf.context.flateStream(`BT /F1 14 Tf 40 700 Td <${content}> Tj ET`)))
  }
  const path = join(root, name); await writeFile(path, await pdf.save()); return path
}
const chineseLeft = await chineseFixture('中文控制方法研究.pdf', '本文研究电机控制方法，分析参数变化对控制系统稳定性的影响。')
const chineseRight = await chineseFixture('中文控制方法综述.pdf', '本文比较不同控制方法的性能，重点讨论扰动估计和实验结果。')
const invalid = join(root, '损坏.pdf'); await writeFile(invalid, '%PDF-invalid')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const launch = () => electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), original, `--data-dir=${join(root, 'data')}`], env })
async function drop(page, path, target, preview = false) {
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'pair-drop-file'; input.hidden = true; document.body.append(input) })
  await page.locator('#pair-drop-file').setInputFiles(path)
  const dispatch = type => page.locator('#pair-drop-file').evaluate((input, { target, type }) => {
    const transfer = new DataTransfer(); for (const file of input.files) transfer.items.add(file)
    document.querySelector(target).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { target, type })
  if (preview) {
    await dispatch('dragover')
    await page.locator('.pane-drop-overlay').waitFor({ timeout: 5000 })
    const bounds = await page.locator('.pane-drop-overlay').boundingBox()
    const left = await page.locator('[data-side="left"]').boundingBox()
    assert(bounds.x >= left.x + left.width, 'translation drop hint must cover only the right pane')
    await page.screenshot({ path: join(root, 'drop-hint.png') })
  }
  await dispatch('drop')
  await page.locator('#pair-drop-file').evaluate(input => input.remove())
}
async function ready(page, pages = 4, name = '英文原文.pdf') {
  await page.waitForFunction(({pages, name}) => document.querySelector('.document-title')?.textContent.includes(name) && document.querySelector('[data-side="right"] .textLayer span') && document.querySelector('[aria-label="右侧页码"]')?.nextElementSibling?.textContent.includes(String(pages)) && !document.querySelector('.document-bar .primary').disabled, {pages, name}, { timeout: 10000 })
}
async function note(page, side, number, text) {
  await page.locator(`[data-side="${side}"] [data-page="${number}"] .textLayer span`).first().evaluate(span => {
    const range = document.createRange(); range.selectNodeContents(span); getSelection().removeAllRanges(); getSelection().addRange(range)
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '添加备注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).last().fill(text)
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
}
const errors = []
const app = await launch(); let page
try {
  page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message))
  await page.locator('[data-side="left"] .textLayer span').first().waitFor()
  await page.getByRole('button', { name: '展开论文列表', exact: true }).click()
  await page.getByLabel('左侧页码', { exact: true }).fill('2'); await page.getByLabel('左侧页码', { exact: true }).press('Enter')
  await page.getByLabel('左侧缩放').selectOption('1.25')
  await page.locator('[data-side="left"] [data-page="2"] .textLayer span').first().waitFor()
  await note(page, 'left', 2, '原文批注保留')
  await drop(page, translated, '[data-side="right"] .translation-empty')
  await ready(page)
  for (const path of [original, translated]) assert.equal((await page.evaluate(path => window.reader.selectPdf(path), path)).value.language, 'en', 'English-English comparison must be supported')
  assert.equal(await page.getByRole('dialog', { name: '导入对照论文' }).count(), 0, 'direct drop must import without another dialog')
  assert.equal(await page.locator('.document-list-item').count(), 1, 'counterpart must stay in the original paper entry')
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '2')
  assert.equal(await page.getByLabel('左侧缩放').inputValue(), '1.25')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '原文批注保留')
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
  await page.locator('[data-side="right"] [data-page="2"] .textLayer span').first().waitFor()
  await note(page, 'right', 2, '此中文版本的批注')
  await drop(page, replacement, '[data-side="right"] .pdf-scroll', true)
  await ready(page, 3)
  assert.equal(await page.locator('.document-list-item').count(), 1)
  assert(await page.getByRole('button', { name: '联动阅读', exact: true }).isDisabled(), 'unequal pagination must disable linking')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  assert.equal(await page.getByLabel('批注备注', { exact: true }).count(), 1, 'old Chinese-version notes must not appear on a replacement')
  assert.equal(await page.getByLabel('批注备注', { exact: true }).inputValue(), '原文批注保留')
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
  for (const [path, message] of [[invalid, /损坏|无效|PDF/], [original, /相同内容/]]) {
    await drop(page, path, '[data-side="right"] .pdf-scroll')
    await page.getByRole('status').filter({ hasText: message }).waitFor()
    assert.equal(await page.locator('.document-list-item').count(), 1)
    await ready(page, 3)
  }
  await drop(page, translated, '[data-side="right"] .pane-language')
  await ready(page)
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).nth(1).waitFor()
  assert.deepEqual(await page.getByLabel('批注备注', { exact: true }).evaluateAll(inputs => inputs.map(input => input.value).sort()), ['原文批注保留', '此中文版本的批注'])
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
  await page.screenshot({ path: join(root, 'paired.png') })
  await drop(page, separate, '.document-bar')
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent.includes('独立论文.pdf') && document.querySelectorAll('.document-list-item').length === 2)
  await page.getByRole('button', { name: '切换到论文：英文原文.pdf', exact: true }).click()
  await ready(page)
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '2')
  // External file dropped on the left changes only the left paper.
  await page.getByLabel('右侧页码', { exact: true }).fill('3'); await page.getByLabel('右侧页码', { exact: true }).press('Enter')
  await page.getByLabel('右侧缩放').selectOption('0.8')
  await drop(page, separate, '[data-side="left"] .pdf-scroll')
  await ready(page, 4, '独立论文.pdf')
  assert.equal(await page.getByLabel('右侧页码', { exact: true }).inputValue(), '3')
  assert.equal(await page.getByLabel('右侧缩放').inputValue(), '0.8')
  assert((await page.locator('[data-side="right"] .pane-file-name').textContent()).includes('中文版本.pdf'))
  assert.equal(await page.locator('.document-list-item').count(), 2, 'replacing left with an already open paper must not lose the previous paper')
  await page.getByRole('button', { name: '切换到论文：英文原文.pdf', exact: true }).click(); await ready(page)
  // Native in-app drag still works after the original external file has moved.
  await rename(separate, join(root, 'moved-independent.pdf'))
  await page.getByRole('button', { name: '切换到论文：独立论文.pdf', exact: true }).dragTo(page.locator('[data-side="right"] .pdf-scroll'))
  await page.waitForFunction(() => document.querySelector('[data-side="right"] .pane-file-name')?.textContent.includes('独立论文.pdf'))
  assert.equal(await page.locator('.document-list-item').count(), 2)
  await drop(page, translated, '[data-side="right"] .pdf-scroll'); await ready(page)
  // Two real Chinese papers retain the user's left/right order and neutral labels.
  for (const path of [chineseLeft, chineseRight]) assert.equal((await page.evaluate(path => window.reader.selectPdf(path), path)).value.language, 'zh')
  await drop(page, [chineseLeft, chineseRight], '.document-bar')
  await page.getByRole('dialog', { name: '导入对照论文' }).waitFor()
  await page.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await ready(page, 3, '中文控制方法研究.pdf')
  assert.equal(await page.locator('[data-side="left"] .pane-file-name').textContent(), '中文控制方法研究.pdf')
  assert.equal(await page.locator('[data-side="right"] .pane-file-name').textContent(), '中文控制方法综述.pdf')
  assert.equal(await page.getByLabel('阅读模式').inputValue(), 'parallel')
  assert.equal(await page.locator('.document-list-item').count(), 3)
  await page.screenshot({ path: join(root, 'chinese-chinese.png') })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.screenshot({ path: join(root, 'minimum.png') })
  const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.querySelector('.app-shell').scrollWidth, titles: Array.from(document.querySelectorAll('.pane-file-name')).map(node => ({ width: node.getBoundingClientRect().width, text: node.textContent })) }))
  assert(layout.width <= layout.viewport + 1 && layout.titles.every(title => title.width > 0), `minimum window must show filenames without page overflow: ${JSON.stringify(layout)}`)
  await page.getByRole('button', { name: '切换到论文：英文原文.pdf', exact: true }).click(); await ready(page)
  await page.getByLabel('左侧页码', { exact: true }).fill('2'); await page.getByLabel('左侧页码', { exact: true }).press('Enter')
  // Consecutive drops on opposite sides must compose even while import is pending.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('reader:import-side'); let slow = true
    ipcMain.removeHandler('reader:import-side')
    ipcMain.handle('reader:import-side', async (...args) => {
      const result = await handler(...args)
      if (slow) { slow = false; globalThis.__pairDropPending = true; await new Promise(resolve => setTimeout(resolve, 700)); globalThis.__pairDropPending = false }
      return result
    })
  })
  await drop(page, queuedLeft, '[data-side="left"] .pdf-scroll')
  await app.evaluate(async () => {
    const deadline = Date.now() + 3000
    while (!globalThis.__pairDropPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (!globalThis.__pairDropPending) throw new Error('Expected pending pane import')
  })
  await drop(page, queuedRight, '[data-side="right"] .pdf-scroll')
  await ready(page, 4, '连续拖入-左侧.pdf')
  await page.waitForFunction(() => document.querySelector('[data-side="right"] .pane-file-name')?.textContent.includes('连续拖入-右侧.pdf') && !document.querySelector('.document-bar .primary').disabled)
  await page.getByRole('button', { name: '切换到论文：英文原文.pdf', exact: true }).click(); await ready(page)
  assert.deepEqual(errors, [])
} catch (error) {
  if (page) await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
const restarted = await launch()
try {
  const page = await restarted.firstWindow(); await ready(page)
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '2')
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  await page.getByLabel('批注备注', { exact: true }).nth(1).waitFor()
  assert.deepEqual(await page.getByLabel('批注备注', { exact: true }).evaluateAll(inputs => inputs.map(input => input.value).sort()), ['原文批注保留', '此中文版本的批注'])
} finally { await restarted.close() }
console.log(`Pair drop passed: placeholder/live/header targets, local hint, direct pairing, replacement, protected errors, notes/positions, global append and restart. Screenshots: ${root}`)
