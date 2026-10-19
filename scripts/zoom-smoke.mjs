import { _electron as electron } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import assert from 'node:assert/strict'

const root = resolve(`output/playwright/zoom-${Date.now()}`)
await mkdir(root, { recursive: true })
const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.TimesRoman)
for (let n = 0; n < 48; n++) {
  const sheet = pdf.addPage(n % 3 === 1 ? [640, 900] : [595, 842])
  for (let line = 0; line < 45; line++) sheet.drawText(`Page ${n + 1}. Cursor anchored zoom preserves text under the pointer. Line ${line + 1}.`, { x: 40, y: 780 - line * 16, size: 10, font })
}
const original = process.env.PAPER_READER_ZOOM_FIXTURE ?? join(root, 'original.pdf')
if (!process.env.PAPER_READER_ZOOM_FIXTURE) await writeFile(original, await pdf.save())
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), original, `--data-dir=${join(root, 'data')}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], env })
try {
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('.textLayer span').first().waitFor({ timeout: 30000 })
  await page.getByLabel('阅读模式').selectOption('original')
  const pane = page.locator('[data-side="left"]')
  const zoom = pane.locator('.pane-controls select')
  await zoom.selectOption('1.5')
  await pane.locator('.pane-controls input').fill('2'); await pane.locator('.pane-controls input').press('Enter')
  await pane.locator('[data-page="2"] .textLayer span').first().waitFor()
  await page.waitForTimeout(400)
  const textBeforeZoom = await pane.locator('[data-page="2"] .textLayer span').first().elementHandle()
  const anchor = await pane.locator('.pdf-scroll').evaluate(async element => {
    element.scrollTop = element.querySelector('[data-page="2"]').offsetTop + 130
    element.scrollLeft = 60
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const paper = element.querySelector('[data-page="2"] .pdf-paper'); const rect = paper.getBoundingClientRect()
    const viewport = element.getBoundingClientRect()
    const clientX = viewport.left + element.clientWidth * .57
    const clientY = viewport.top + element.clientHeight * .48
    return { clientX, clientY, x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height }
  })
  const wheel = async deltaY => {
    await page.mouse.move(anchor.clientX, anchor.clientY)
    await page.keyboard.down('Control')
    try { await page.mouse.wheel(0, deltaY) } finally { await page.keyboard.up('Control') }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const displacement = async () => pane.locator('[data-page="2"] .pdf-paper').evaluate((paper, anchor) => {
    const rect = paper.getBoundingClientRect()
    return { dx: rect.left + anchor.x * rect.width - anchor.clientX, dy: rect.top + anchor.y * rect.height - anchor.clientY }
  }, anchor)
  await wheel(-120)
  await page.waitForFunction(() => document.querySelector('.pane-controls select').value === '2')
  const immediate = await displacement()
  await page.waitForTimeout(550)
  const settled = await displacement()
  const anchorReport = { immediate, settled }
  await writeFile(join(root, 'anchor.json'), JSON.stringify(anchorReport, null, 2))
  console.log(JSON.stringify({ anchor: anchorReport, root }))
  if (!process.argv.includes('--profile-only')) {
    assert(await textBeforeZoom.evaluate(node => node.isConnected), 'Zooming unchanged PDF text must reuse its text layer instead of rebuilding it on the input thread')
    for (const result of [immediate, settled]) {
      assert(Math.abs(result.dx) <= 2, `Cursor content drifted horizontally by ${result.dx}px`)
      assert(Math.abs(result.dy) <= 2, `Cursor content drifted vertically by ${result.dy}px`)
    }
    await wheel(120)
    const reversed = await displacement()
    assert(Math.abs(reversed.dx) <= 2 && Math.abs(reversed.dy) <= 2, `Zooming out moved the cursor content: ${JSON.stringify(reversed)}`)
    const scrollBefore = await pane.locator('.pdf-scroll').evaluate(element => element.scrollTop)
    await page.mouse.wheel(0, 90)
    await page.waitForFunction(top => document.querySelector('.pdf-scroll').scrollTop > top + 50, scrollBefore)
    await page.waitForTimeout(300)
    assert(await pane.locator('.pdf-scroll').evaluate(element => element.scrollTop) > scrollBefore + 50, 'Ordinary scroll during zoom settlement must not snap back to the old pointer anchor')
    await pane.locator('[data-page="2"] .textLayer span').first().waitFor()
    const selection = await pane.locator('[data-page="2"] .textLayer span').evaluateAll(spans => {
      const viewport = spans[0].closest('.pdf-scroll').getBoundingClientRect()
      return spans.some(span => {
        const rect = span.getBoundingClientRect()
        const left = Math.max(rect.left, viewport.left); const right = Math.min(rect.right, viewport.right - 20)
        if (rect.top < viewport.top + 5 || rect.bottom > viewport.bottom - 5 || right - left < 5) return false
        const caret = document.caretRangeFromPoint((left + right) / 2, rect.top + rect.height / 2)
        return Boolean(caret && span.contains(caret.startContainer))
      })
    })
    assert(selection, 'Text hit testing after zoom must still match the visible text')
    await zoom.selectOption('1.5')
    await pane.locator('.pane-controls input').fill('1'); await pane.locator('.pane-controls input').press('Enter')
    await page.waitForTimeout(300)
    const corner = await pane.locator('.pdf-scroll').evaluate(async element => {
      element.scrollTop = 0; element.scrollLeft = 0
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const bounds = element.getBoundingClientRect(); return { x: bounds.left + .1, y: bounds.top + 1 }
    })
    await page.mouse.move(corner.x, corner.y)
    await page.keyboard.down('Control')
    try { await page.mouse.wheel(0, -120) } finally { await page.keyboard.up('Control') }
    await page.waitForFunction(() => document.querySelector('.pane-controls select').value === '2')
    await page.mouse.wheel(90, 0)
    await page.waitForFunction(() => document.querySelector('.pdf-scroll').scrollLeft > 40)
    await page.waitForTimeout(300)
    assert(await pane.locator('.pdf-scroll').evaluate(element => element.scrollLeft) > 40, 'Horizontal input after a clamped zoom must cancel the old anchor instead of snapping back')
  }
  const traceClient = process.argv.includes('--trace') ? await page.context().newCDPSession(page) : null
  const traceEvents = []
  if (traceClient) {
    traceClient.on('Tracing.dataCollected', event => traceEvents.push(...event.value))
    await traceClient.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8,blink.user_timing', options: 'record-as-much-as-possible' })
  }
  await page.evaluate(() => {
    const data = window.zoomProfile = { frames: [], pointerLatency: [], longTasks: [], wheelEvents: 0, rendersBefore: window.__pdfPerformance.canvasRenders }
    let running = true; let previous = performance.now()
    const tick = now => { data.frames.push(now - previous); previous = now; if (running) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    const pointer = event => data.pointerLatency.push(Math.max(0, performance.now() - event.timeStamp))
    const wheel = () => data.wheelEvents++
    window.addEventListener('pointermove', pointer); window.addEventListener('wheel', wheel)
    const observer = new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(entry => entry.duration)))
    observer.observe({ type: 'longtask' })
    window.stopZoomProfile = () => { running = false; observer.disconnect(); window.removeEventListener('pointermove', pointer); window.removeEventListener('wheel', wheel); return { ...data, rendersAfter: window.__pdfPerformance.canvasRenders } }
  })
  await page.keyboard.down('Control')
  try {
    for (let i = 0; i < 48; i++) {
      await page.mouse.wheel(0, Math.floor(i / 4) % 2 ? 120 : -120)
      await page.mouse.move(anchor.clientX + Math.sin(i) * 45, anchor.clientY + Math.cos(i) * 45)
    }
  } finally { await page.keyboard.up('Control') }
  if (process.argv.includes('--settle-profile')) {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('Control')
      try { await page.mouse.wheel(0, i % 2 ? 120 : -120) } finally { await page.keyboard.up('Control') }
      for (let move = 0; move < 30; move++) {
        await page.mouse.move(anchor.clientX + Math.sin(move / 4) * 70, anchor.clientY + Math.cos(move / 4) * 70)
        await page.waitForTimeout(10)
      }
    }
  }
  const profile = await page.evaluate(() => window.stopZoomProfile())
  const percentile = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0
  const summary = { wheelEvents: profile.wheelEvents, frames: profile.frames.length, p95FrameMs: percentile(profile.frames), maxFrameMs: Math.max(0, ...profile.frames), p95PointerLatencyMs: percentile(profile.pointerLatency), maxPointerLatencyMs: Math.max(0, ...profile.pointerLatency), longTasks: profile.longTasks, rasterStartsDuringGesture: profile.rendersAfter - profile.rendersBefore }
  await writeFile(join(root, 'profile.json'), JSON.stringify({ summary, samples: profile }, null, 2))
  console.log(JSON.stringify(summary))
  if (process.argv.includes('--settle-profile') && !process.argv.includes('--profile-only') && !traceClient) {
    assert(summary.longTasks.length === 0 && summary.maxFrameMs < 50 && summary.maxPointerLatencyMs < 25, `Zoom and settlement must not block pointer input: ${JSON.stringify(summary)}`)
  }
  if (traceClient) {
    const complete = new Promise(resolve => traceClient.once('Tracing.tracingComplete', resolve))
    await traceClient.send('Tracing.end'); await complete
    await writeFile(join(root, 'trace.json'), JSON.stringify({ traceEvents }))
    console.log(JSON.stringify({ slowTrace: traceEvents.filter(event => event.ph === 'X' && event.dur > 20000).sort((a, b) => b.dur - a.dur).slice(0, 18).map(event => ({ name: event.name, durationMs: event.dur / 1000, data: event.args?.data })) }))
  }
  if (process.argv.includes('--check-clear-scroll')) {
    await zoom.selectOption('1')
    await pane.locator('.pane-controls input').fill('1'); await pane.locator('.pane-controls input').press('Enter')
    await pane.locator('.textLayer span').first().waitFor()
    await pane.locator('.pdf-scroll').hover()
    const samples = []
    for (let i = 0; i < 24; i++) {
      await page.mouse.wheel(0, i < 12 ? 130 : -130)
      samples.push(...await pane.locator('.canvas-holder canvas').evaluateAll(canvases => {
        const viewport = document.querySelector('.pdf-scroll').getBoundingClientRect()
        return canvases.filter(canvas => { const r = canvas.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom }).map(canvas => ({ quality: canvas.dataset.quality, pixelsPerCssPixel: canvas.width / canvas.getBoundingClientRect().width }))
      }))
    }
    await writeFile(join(root, 'scroll-quality.json'), JSON.stringify(samples, null, 2))
    assert(samples.length > 0)
    assert(samples.every(sample => sample.quality === 'clear'), 'Scrolling must never display a low resolution preview')
    const coldPdf = join(root, 'cold.pdf'); await writeFile(coldPdf, await pdf.save())
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, coldPdf)
    await page.getByRole('button', { name: /打开论文/ }).first().click()
    await page.getByText('cold.pdf', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('.pane-controls form span').textContent.includes('48'))
    await pane.locator('[data-page="1"] .textLayer span').first().waitFor()
    await page.evaluate(() => {
      window.originalImageBitmap = window.createImageBitmap
      window.createImageBitmap = async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 260))
        return window.originalImageBitmap(...args)
      }
    })
    try {
      await pane.locator('.pane-controls input').fill('40'); await pane.locator('.pane-controls input').press('Enter')
      await pane.locator('.pdf-scroll').hover()
      let paintedWhileScrolling = false
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, 30)
        await page.waitForTimeout(180)
        paintedWhileScrolling ||= await pane.locator('[data-page="40"] canvas[data-quality="clear"]').count() > 0
      }
      assert(paintedWhileScrolling, 'A slow cold page must finish its clear render while scrolling continues instead of restarting at every settlement')
    } finally {
      await page.evaluate(() => { window.createImageBitmap = window.originalImageBitmap; delete window.originalImageBitmap })
    }
  }
  await page.screenshot({ path: join(root, 'zoom.png') })
  assert.deepEqual(errors, [])
} finally { await app.close() }
