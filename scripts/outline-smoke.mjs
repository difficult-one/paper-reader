import { _electron as electron } from 'playwright'
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(`output/playwright/outline-${Date.now()}`)
await mkdir(root, { recursive: true })
async function fixture(name, prefix, bookmarks = true) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
  for (let n = 1; n <= 8; n++) {
    const page = pdf.addPage([600, 800])
    for (let line = 0; line < 28; line++) page.drawText(`${prefix} page ${n}, line ${line + 1}: chapter navigation test.`, { x: 40, y: 740 - line * 22, size: 12, font })
  }
  if (bookmarks) {
    const context = pdf.context
    const outline = context.nextRef(); const intro = context.nextRef(); const methods = context.nextRef(); const data = context.nextRef(); const conclusion = context.nextRef(); const broken = context.nextRef()
    const target = (page, top = 800) => context.obj([pdf.getPage(page - 1).ref, 'XYZ', null, top, null])
    context.assign(outline, context.obj({ Type: 'Outlines', First: intro, Last: broken, Count: 5 }))
    context.assign(intro, context.obj({ Title: PDFHexString.fromText(`${prefix} Introduction`), Parent: outline, Next: methods, Dest: target(1) }))
    context.assign(methods, context.obj({ Title: PDFHexString.fromText(`${prefix} Methods`), Parent: outline, Prev: intro, Next: conclusion, First: data, Last: data, Count: 1, Dest: PDFString.of('methods') }))
    context.assign(data, context.obj({ Title: PDFHexString.fromText(`${prefix} Data`), Parent: methods, Dest: target(4) }))
    context.assign(conclusion, context.obj({ Title: PDFHexString.fromText(`${prefix} Conclusion with a long chapter title that should wrap within the sidebar without horizontal overflow`), Parent: outline, Prev: methods, Next: broken, Dest: target(7) }))
    context.assign(broken, context.obj({ Title: PDFHexString.fromText(`${prefix} Invalid chapter`), Parent: outline, Prev: conclusion, Dest: PDFString.of('missing-destination') }))
    pdf.catalog.set(PDFName.of('Outlines'), outline)
    pdf.catalog.set(PDFName.of('Names'), context.obj({ Dests: { Names: [PDFString.of('methods'), target(3, 620)] } }))
  }
  const path = join(root, name); await writeFile(path, await pdf.save()); return path
}
const first = await fixture('章节论文.pdf', 'Left')
const paired = await fixture('对照论文.pdf', 'Right')
const plain = await fixture('无目录论文.pdf', 'Plain', false)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const launch = file => electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), file, `--data-dir=${join(root, 'data')}`], env })
const waitPage = (page, side, number) => page.waitForFunction(({ side, number }) => document.querySelector(`[aria-label="${side === 'left' ? '左侧' : '右侧'}页码"]`)?.value === String(number), { side, number })
const panelOf = page => page.getByRole('complementary', { name: '章节目录', exact: true })
async function openFile(app, page, path) {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, path)
  await page.locator('.document-bar .primary').click()
  await page.locator('[data-side="left"] .textLayer span').first().waitFor()
}

let app = await launch(first)
try {
  let page = await app.firstWindow(); page.setDefaultTimeout(12000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 1000))
  await page.locator('[data-side="left"] .textLayer span').first().waitFor()
  await page.getByLabel('阅读模式').selectOption('original')
  const expanded = page.getByRole('button', { name: '展开章节目录', exact: true })
  await expanded.waitFor({ timeout: 4000 }); await expanded.click()
  const panel = panelOf(page)
  await panel.getByRole('button', { name: 'Left Methods', exact: true }).click()
  await waitPage(page, 'left', 3)
  const fraction = await page.locator('[data-side="left"] .pdf-scroll').evaluate(element => {
    const slot = element.querySelector('[data-page="3"]')
    return (element.scrollTop - slot.offsetTop) / slot.offsetHeight
  })
  assert(Math.abs(fraction - .225) < .035, `named chapter must preserve its page offset, got ${fraction}`)
  await panel.getByRole('button', { name: 'Left Data', exact: true }).click(); await waitPage(page, 'left', 4)
  await panel.getByRole('button', { name: '收起子章节：Left Methods', exact: true }).click()
  assert.equal(await panel.getByRole('button', { name: 'Left Data', exact: true }).count(), 0)
  await panel.getByRole('button', { name: '展开子章节：Left Methods', exact: true }).click()
  await panel.getByRole('button', { name: 'Left Data', exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Left Invalid chapter', exact: true }).click()
  await panel.getByRole('status').filter({ hasText: /无法定位/ }).waitFor()
  await waitPage(page, 'left', 4)
  const narrow = await page.locator('.reading-workspace').boundingBox()
  await page.screenshot({ path: join(root, 'expanded.png') })
  await panel.getByRole('button', { name: '收起章节目录', exact: true }).click()
  assert.equal(await panel.isVisible(), false)
  assert((await page.locator('.reading-workspace').boundingBox()).width > narrow.width + 200, 'closing must reclaim sidebar width')
  await page.screenshot({ path: join(root, 'collapsed.png') })
  await page.getByRole('button', { name: '展开章节目录', exact: true }).click(); await waitPage(page, 'left', 4)
  await page.keyboard.press('Escape'); assert.equal(await panel.isVisible(), false)

  await page.getByRole('button', { name: '导入对照论文', exact: true }).first().click()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, paired)
  await page.getByRole('button', { name: '选择右侧 PDF', exact: true }).click()
  await page.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.locator('[data-side="right"] .textLayer span').first().waitFor()
  await page.getByRole('button', { name: '展开章节目录', exact: true }).click()
  await panel.getByLabel('目录来源').selectOption('right')
  await panel.getByRole('button', { name: 'Right Methods', exact: true }).click()
  await waitPage(page, 'right', 3); await waitPage(page, 'left', 3)
  await page.getByRole('button', { name: '联动阅读', exact: true }).click()
  await panel.getByRole('button', { name: 'Right Data', exact: true }).click()
  await waitPage(page, 'right', 4); await waitPage(page, 'left', 3)
  await page.getByLabel('阅读模式').selectOption('original')
  await panel.getByRole('button', { name: 'Left Methods', exact: true }).waitFor()
  await page.getByLabel('阅读模式').selectOption('translated')
  await panel.getByRole('button', { name: 'Right Methods', exact: true }).waitFor()
  await page.getByLabel('阅读模式').selectOption('parallel')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 768))
  await page.getByRole('button', { name: '我的批注', exact: true }).click()
  assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
  const toolbar = await page.locator('.document-bar').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  assert(toolbar.scroll <= toolbar.width + 1, `toolbar overflow at minimum width: ${JSON.stringify(toolbar)}`)
  await page.screenshot({ path: join(root, 'narrow.png') })
  await page.getByRole('button', { name: '关闭批注侧栏', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1480, 1000))

  await page.getByRole('button', { name: '展开论文列表', exact: true }).click()
  assert.equal(await panel.isVisible(), false)
  await page.getByRole('button', { name: '展开章节目录', exact: true }).click()
  assert.equal(await page.getByRole('complementary', { name: '已打开的论文', exact: true }).isVisible(), false)
  await openFile(app, page, plain)
  await page.getByLabel('阅读模式').selectOption('original')
  await panel.getByText(/没有内置章节目录/).waitFor()
  assert.equal(await panel.getByRole('button', { name: 'Left Methods', exact: true }).count(), 0)
  await panel.getByRole('button', { name: '第 6 页', exact: true }).click(); await waitPage(page, 'left', 6)
  await page.screenshot({ path: join(root, 'fallback.png') })
  await page.getByRole('button', { name: '展开论文列表', exact: true }).click()
  await page.getByRole('button', { name: '切换到论文：章节论文.pdf', exact: true }).click()
  await page.getByRole('button', { name: '展开章节目录', exact: true }).click()
  await panel.getByLabel('目录来源').selectOption('left')
  await panel.getByRole('button', { name: 'Left Data', exact: true }).click(); await waitPage(page, 'left', 4)
  await app.close(); app = null
  app = await launch(first); page = await app.firstWindow(); page.setDefaultTimeout(12000)
  await page.locator('[data-side="left"] .textLayer span').first().waitFor()
  await waitPage(page, 'left', 4)
  await page.getByRole('button', { name: '展开章节目录', exact: true }).click()
  await panelOf(page).getByRole('button', { name: 'Left Methods', exact: true }).waitFor()
  console.log(JSON.stringify({ ok: true, checks: ['nested chapters', 'named destinations and offsets', 'invalid destination recovery', 'child disclosure', 'collapse and width recovery', 'Escape', 'paired sources', 'linked and independent jumps', 'single-pane modes', 'narrow layout', 'paper list coexistence', 'missing-outline fallback', 'document replacement', 'saved position'], artifacts: root }))
} catch (error) {
  if (app) { const windows = app.windows(); if (windows[0]) await windows[0].screenshot({ path: join(root, 'failure.png') }).catch(() => {}) }
  throw error
} finally { if (app) await app.close() }
