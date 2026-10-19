import { _electron as electron } from 'playwright'
import { PDFDocument } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const fixture = resolve(process.argv[2] || 'output/playwright/attention.pdf')
const count = (await PDFDocument.load(await readFile(fixture))).getPageCount()
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executable = process.env.PAPER_READER_EXECUTABLE
if (executable) env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`
const app = await electron.launch({ ...(executable ? { executablePath: resolve(executable) } : {}), args: [...(executable ? [] : ['.']), fixture, `--data-dir=${resolve('output/playwright/research-paper-profile')}`], env })
try {
  const page = await app.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.getByLabel('阅读模式').selectOption('original')
  for (const number of [1, 3, 5, count]) {
    await page.getByLabel('英文页码', { exact: true }).fill(String(number))
    await page.getByLabel('英文页码', { exact: true }).press('Enter')
    await page.locator(`[data-side="left"] [data-page="${number}"] .textLayer span`).first().waitFor()
    assert.equal(await page.locator('.page-error').count(), 0)
    if (number === 3) await page.screenshot({ path: 'output/playwright/research-paper-formulas.png' })
  }
  const canvasCount = await page.locator('canvas').count()
  assert(canvasCount < count, 'distant pages must release their canvases')
  await page.getByLabel('英文缩放').selectOption('1.25')
  await page.setViewportSize({ width: 1200, height: 800 })
  assert.equal(await page.getByLabel('英文页码', { exact: true }).inputValue(), String(count))
  assert.deepEqual(errors, [])
  console.log(`Research PDF passed: ${count} pages; text, figures, formulas and references render; ${canvasCount} canvases retained after scrolling; page preserved on zoom/resize.`)
} finally { await app.close() }
