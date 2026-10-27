import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { performanceFailures, summarizeFrames } from '../src/shared/reader-performance.ts'
import { runScrollProfile } from './scroll-profile.mjs'
import { makeScrollFixture } from './scroll-fixtures.mjs'
import { addScrollAnnotations, startScrollBackground } from './scroll-background.mjs'

const option = (name, fallback) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback
const pages = Number(option('pages', 96))
assert(Number.isInteger(pages) && pages > 2, '--pages must be an integer greater than two')
const profile = process.argv.includes('--profile') || process.argv.includes('--release')
const refreshHz = Number(option('refresh-hz', 60))

await mkdir('output/playwright', { recursive: true })
let source
try { source = await PDFDocument.load(await readFile(option('fixture-path', 'output/playwright/attention.pdf'))) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  source = await PDFDocument.create()
  const font = await source.embedFont(StandardFonts.TimesRoman)
  const sample = source.addPage([595, 842])
  for (let i = 0; i < 40; i++) sample.drawText(`Synthetic scientific reading fixture. Paragraph ${i + 1}: verify data and conditions.`, { x: 40, y: 780 - i * 18, size: 11, font })
}
if (option('fixture', '')) source = await makeScrollFixture(option('fixture', 'text'))
const long = await PDFDocument.create()
for (let i = 0; i < pages; i++) long.addPage((await long.copyPages(source, [i % source.getPageCount()]))[0])
const original = resolve('output/playwright/scroll-original.pdf')
const translated = resolve('output/playwright/scroll-paired.pdf')
await writeFile(original, await long.save()); long.setTitle('Scroll test counterpart'); await writeFile(translated, await long.save())
const baseline = process.argv.includes('--baseline')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app2 = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), original, ...(option('dpr', '') ? [`--force-device-scale-factor=${Number(option('dpr', 1))}`] : []), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', `--data-dir=${resolve(`output/playwright/scroll-active-${baseline ? 'before' : 'after'}-${Date.now()}`)}`], env })
let stopBackground
try {
  await app2.evaluate(({ BrowserWindow }, foreground) => BrowserWindow.getAllWindows().forEach(window => {
    window.webContents.setBackgroundThrottling(false)
    if (foreground) { window.setMinimizable(false); window.restore(); window.show(); window.setAlwaysOnTop(true); window.focus() }
  }), process.argv.includes('--foreground'))
  const page = await app2.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('[data-side="left"] .canvas-holder canvas').first().waitFor({ timeout: 30000 })
  if (option('dpr', '') || option('cache-mib', '') || option('flags', '') || process.argv.includes('--raster-trace')) {
    const url = new URL(page.url())
    if (option('cache-mib', '')) url.searchParams.set('pdf-cache-mib', option('cache-mib', '64'))
    if (process.argv.includes('--raster-trace')) url.searchParams.set('pdf-raster-trace', '1')
    for (const name of option('flags', '').split(',').filter(Boolean)) url.searchParams.set(`pdf-${name}`, 'off')
    // Use Chromium's process scale factor: Playwright screenshots reset CDP
    // metrics overrides. Native window resizing must retain the requested DPR.
    await page.goto(url.href)
    if (option('dpr', '')) assert(Math.abs(await page.evaluate(() => devicePixelRatio) - Number(option('dpr', 1))) < 1e-6, 'requested DPR must actually apply')
  }
  await page.locator('[data-side="left"] .canvas-holder canvas').first().waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '导入对照论文', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await app2.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, translated)
  await dialog.getByRole('button', { name: '选择右侧 PDF', exact: true }).click()
  await dialog.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.locator('[data-side="right"] .canvas-holder canvas').first().waitFor({ timeout: 30000 })
  const annotationCount = Number(option('annotations-per-page', 0))
  if (annotationCount) console.log(JSON.stringify({ annotationMarks: await addScrollAnnotations(page, original, annotationCount) }))
  stopBackground = process.argv.includes('--background-ui') ? await startScrollBackground(app2, page, original) : null
  if (option('zoom', '')) await page.locator('[data-side="left"] .pane-controls select').selectOption(option('zoom', '1'))
  if (option('mode', '')) await page.getByLabel('阅读模式', { exact: true }).selectOption(option('mode', 'parallel'))
  if (profile) {
    await runScrollProfile(app2, page, { durationMs: Number(option('duration-ms', 60000)), rounds: Number(option('rounds', 3)), soakMs: Number(option('soak-ms', process.argv.includes('--release') ? 600000 : 0)), refreshHz, baseline, requestedDpr: option('dpr', '') ? Number(option('dpr', '')) : undefined, coldOnly: process.argv.includes('--cold-only'), trace: process.argv.includes('--trace'), label: option('label', baseline ? 'performance-before' : 'performance-after') })
    if (stopBackground) {
      const background = await stopBackground()
      await writeFile(resolve('output/playwright', option('label', 'performance-after'), 'background.json'), JSON.stringify(background, null, 2))
      stopBackground = null
    }
    assert.deepEqual(errors, [])
    process.exitCode = 0
  } else {
  const metrics = await page.evaluate(async () => {
    let geometryReads = 0
    for (const name of ['offsetTop', 'offsetHeight']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { ...descriptor, get() { if (this.classList.contains('page-slot')) geometryReads++; return descriptor.get.call(this) } })
    }
    const pane = document.querySelector('[data-side="left"] .pdf-scroll')
    const frames = []; let last = performance.now(); let active = true
    function tick(now) { frames.push(now - last); last = now; if (active) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    for (let i = 0; i < 100; i++) { pane.scrollTop += 38; await new Promise(requestAnimationFrame) }
    for (let i = 0; i < 100; i++) { pane.scrollTop -= 38; await new Promise(requestAnimationFrame) }
    active = false
    return { pages: document.querySelectorAll('.page-slot').length, geometryReads, rawFrames: frames, canvases: document.querySelectorAll('canvas').length }
  })
  Object.assign(metrics, summarizeFrames(metrics.rawFrames))
  await page.screenshot({ path: `output/playwright/scroll-${baseline ? 'before' : 'after'}.png` })
  await writeFile(`output/playwright/scroll-${baseline ? 'before' : 'after'}.json`, JSON.stringify(metrics, null, 2))
  console.log(JSON.stringify({ ...metrics, rawFrames: undefined }))
  // Native wheel + pointer input also exercises PDF rendering as new pages enter both panes.
  await page.getByLabel('左侧页码', { exact: true }).fill('1')
  await page.getByLabel('左侧页码', { exact: true }).press('Enter')
  await page.locator('[data-side="left"] [data-page="1"] .textLayer span').first().waitFor()
  await page.evaluate(() => {
    const data = window.wheelMetrics = { frames: [], maxDrawnPerFrame: 0, drawnFrames: 0, wheelEvents: 0, longTasks: [] }
    const drawn = new Set()
    const methods = ['fillText', 'strokeText', 'drawImage', 'fill', 'stroke']
    const originals = []
    for (const realm of [window, ...[...document.querySelectorAll('iframe')].map(frame => frame.contentWindow)]) {
      const prototype = realm.CanvasRenderingContext2D.prototype
      for (const name of methods) {
        const original = prototype[name]; originals.push({ prototype, name, original })
        prototype[name] = function (...args) {
          if (this.canvas.dataset.pdfRaster || this.canvas.closest('.canvas-holder')) drawn.add(this.canvas)
          return original.apply(this, args)
        }
      }
    }
    let active = true; let last = performance.now()
    const frame = now => {
      data.frames.push(now - last); last = now
      if (drawn.size) data.drawnFrames++
      data.maxDrawnPerFrame = Math.max(data.maxDrawnPerFrame, drawn.size); drawn.clear()
      if (active) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    const wheel = () => data.wheelEvents++
    window.addEventListener('wheel', wheel, { passive: true })
    const observer = new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(entry => entry.duration)))
    observer.observe({ type: 'longtask', buffered: false })
    window.stopWheelMetrics = () => {
      data.longTasks.push(...observer.takeRecords().map(entry => entry.duration))
      active = false; observer.disconnect(); window.removeEventListener('wheel', wheel)
      for (const { prototype, name, original } of originals) prototype[name] = original
    }
  })
  const bounds = await page.locator('[data-side="left"] .pdf-scroll').boundingBox()
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  for (let i = 0; i < 240; i++) {
    await page.mouse.wheel(0, i < 160 ? 110 : -110)
    await page.mouse.move(bounds.x + bounds.width / 2 + Math.sin(i / 8) * 100, bounds.y + bounds.height / 2 + Math.cos(i / 8) * 80)
  }
  const rightBounds = await page.locator('[data-side="right"] .pdf-scroll').boundingBox()
  await page.mouse.move(rightBounds.x + rightBounds.width / 2, rightBounds.y + rightBounds.height / 2)
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -70)
  await page.waitForFunction(() => {
    const [left, right] = document.querySelectorAll('.pane-controls input')
    const panes = document.querySelectorAll('.pdf-scroll')
    return Number(left.value) > 1 && left.value === right.value && Math.abs(panes[0].scrollTop - panes[1].scrollTop) < 2
  })
  const stoppedPage = await page.getByLabel('右侧页码', { exact: true }).inputValue()
  await page.locator(`[data-side="right"] [data-page="${stoppedPage}"] .textLayer span`).first().waitFor()
  const wheelMetrics = await page.evaluate(() => {
    window.stopWheelMetrics()
    const data = window.wheelMetrics
    return { ...data, rawFrames: data.frames }
  })
  Object.assign(wheelMetrics, summarizeFrames(wheelMetrics.rawFrames))
  await writeFile(`output/playwright/wheel-scroll-${baseline ? 'before' : 'after'}.json`, JSON.stringify(wheelMetrics, null, 2))
  console.log('Native wheel:', JSON.stringify({ ...wheelMetrics, rawFrames: undefined }))
  assert.deepEqual(errors, [])
  if (!baseline) {
    assert.deepEqual(performanceFailures({ frames: wheelMetrics.rawFrames, longTasks: wheelMetrics.longTasks, inputLatency: [] }, refreshHz), [], 'native wheel frame time and long tasks must pass the release thresholds')
    assert(wheelMetrics.wheelEvents >= 260, 'continuous native wheel input must reach both reader panes')
    assert(wheelMetrics.drawnFrames > 5, 'the fixture must exercise drawing newly visible PDF pages')
    assert(wheelMetrics.maxDrawnPerFrame <= 1, 'both panes must share the drawing budget instead of rendering multiple PDF canvases in one frame')
    assert(metrics.geometryReads < 1000, 'scrolling must use cached geometry rather than read all page elements every frame')
    await page.getByLabel('左侧页码', { exact: true }).fill('45')
    await page.getByLabel('左侧页码', { exact: true }).press('Enter')
    await page.locator('[data-side="left"] [data-page="45"] .textLayer span').first().waitFor()
    await page.getByLabel('左侧缩放').selectOption('1.25')
    await app2.browserWindow(page).then(window => window.evaluate(window => window.setSize(1200, 800)))
    assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '45')
    assert.equal(await page.getByLabel('右侧页码', { exact: true }).inputValue(), '45')
    await page.getByLabel('左侧缩放').selectOption('3')
    await page.locator('[data-side="left"] [data-page="45"] .textLayer span').first().waitFor()
    assert(await page.locator('canvas').evaluateAll(canvases => canvases.every(canvas => canvas.width * canvas.height < 8_020_000)), 'high-zoom canvas allocations must stay bounded')
    await page.getByRole('button', { name: '联动阅读', exact: true }).click()
    await page.getByLabel('右侧页码', { exact: true }).fill('60')
    await page.getByLabel('右侧页码', { exact: true }).press('Enter')
    assert.equal(await page.getByLabel('左侧页码', { exact: true }).inputValue(), '45')
    console.log('Long PDF: linked page/zoom, resize position, independent panes and high-zoom raster budget passed.')
  }
  }
  if (option('dpr', '')) {
    const actualDpr = await page.evaluate(() => devicePixelRatio)
    assert(Math.abs(actualDpr - Number(option('dpr', 1))) < 1e-6, 'requested DPR must remain active through every check')
    console.log(JSON.stringify({ requestedDpr: Number(option('dpr', 1)), actualDpr, dprRetained: true }))
  }
} finally { if (stopBackground) await stopBackground().catch(() => {}); await app2.close() }
