import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'

const directory = resolve(`output/playwright/inspection-${Date.now()}`)
await mkdir(directory, { recursive: true })
const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
for (let n = 0; n < 300; n++) {
  const sheet = pdf.addPage([595, 842])
  for (let row = 0; row < 100; row++) sheet.drawText(`Scientific inspection fixture page ${n + 1}, row ${row + 1}: preserve responsive IPC while parsing PDF text.`, { font, size: 7, x: 20, y: 820 - row * 8 })
}
const path = join(directory, 'inspection.pdf'); await writeFile(path, await pdf.save())
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), `--data-dir=${join(directory, 'data')}`], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.reader))
  await app.evaluate(() => {
    const data = globalThis.inspectionSampling = { gaps: [], started: performance.now() }
    let last = performance.now()
    data.timer = setInterval(() => { const now = performance.now(); data.gaps.push(now - last); last = now }, 2)
  })
  const results = await page.evaluate(async path => {
    const results = []
    for (let i = 0; i < 4; i++) results.push(await window.reader.selectPdf(path))
    return results
  }, path)
  const metrics = await app.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    const data = globalThis.inspectionSampling; clearInterval(data.timer)
    delete globalThis.inspectionSampling
    return { gaps: data.gaps, elapsedMs: performance.now() - data.started, maxMainLoopGapMs: Math.max(...data.gaps) }
  })
  await writeFile(join(directory, 'report.json'), JSON.stringify({ ...metrics, results }, null, 2))
  console.log(JSON.stringify({ directory, maxMainLoopGapMs: metrics.maxMainLoopGapMs, elapsedMs: metrics.elapsedMs, samples: metrics.gaps.length }))
  assert(results.every(result => result.ok && result.value.pages === 300 && result.value.hasText && result.value.language === 'en'), 'inspection must preserve PDF metadata')
  assert(metrics.gaps.length >= 20, 'inspection must sample the main event loop throughout parsing')
  assert(metrics.maxMainLoopGapMs < 50, 'PDF inspection must not block main-process IPC for 50 ms or longer')
} finally { await app.close() }
