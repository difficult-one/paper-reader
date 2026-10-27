import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(`output/playwright/resume-selection-${Date.now()}`)
await mkdir(root, { recursive: true })
const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
for (let n = 1; n <= 4; n++) {
  const sheet = pdf.addPage([600, 800])
  for (let line = 0; line < 20; line++) sheet.drawText(`Page ${n}. Selection should stay precise for this sentence, even after repeated drags. Line ${line + 1}.`, { x: 40, y: 740 - line * 25, size: 13, font })
}
const file = join(root, 'paper.pdf'); await writeFile(file, await pdf.save())
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const launch = withFile => electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), ...(withFile ? [file] : []), `--data-dir=${join(root, 'data')}`], env })
let app = await launch(true)
try {
  let page = await app.firstWindow()
  await page.locator('[data-side="left"] .textLayer span').first().waitFor({ timeout: 30000 })
  await page.getByLabel('阅读模式').selectOption('original')
  await page.getByLabel('左侧页码', { exact: true }).fill('3'); await page.getByLabel('左侧页码', { exact: true }).press('Enter')
  await page.locator('[data-side="left"] [data-page="3"] .textLayer span').first().waitFor()
  await page.getByLabel('左侧缩放').selectOption('1.25')
  await app.close(); app = await launch(false); page = await app.firstWindow()
  await page.locator('[data-side="left"] [data-page="3"] .textLayer span').first().waitFor({ timeout: 30000 })
  assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '3')
  assert.equal(await page.getByLabel('左侧缩放').inputValue(), '1.25')
  const span = page.locator('[data-side="left"] [data-page="3"] .textLayer span').first()
  await span.evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 5); range.setEnd(element.firstChild, 20)
    getSelection().removeAllRanges(); getSelection().addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').waitFor()
  await page.locator('.status-bar').click()
  await page.getByTestId('selection-toolbar').waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => getSelection().isCollapsed), true)
  const box = await span.boundingBox()
  await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2)
  await page.mouse.down({ clickCount: 3 })
  await page.mouse.move(box.x + box.width * .5, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up({ clickCount: 3 })
  await page.getByTestId('selection-toolbar').waitFor()
  const selected = await page.evaluate(() => getSelection().toString())
  assert(selected.length > 0 && selected.length < 65, `repeated drag selected too much: ${selected}`)
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '黄色高亮' }).click()
  await page.locator('.highlight-mark').first().waitFor()
  console.log('Resume, precise repeated drag, outside dismissal and highlight passed.')
} finally { await app.close() }
