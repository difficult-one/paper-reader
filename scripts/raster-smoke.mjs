import { _electron as electron } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const directory = resolve('output/playwright', process.env.PAPER_READER_EXECUTABLE ? 'packaged-raster-correctness' : 'raster-correctness')
await mkdir(directory, { recursive: true })
const source = resolve('output/playwright/attention.pdf')
const copies = [resolve(directory, 'font-a.pdf'), resolve(directory, 'font-b.pdf')]
const bytes = await readFile(source)
// Keep identical embedded font bytes while giving the library distinct content
// hashes. Exact byte copies would deduplicate to one PDF/session and miss this
// cross-process lifetime regression entirely.
await Promise.all(copies.map((path, index) => writeFile(path, Buffer.concat([bytes, Buffer.from(`\n% raster-document-${index}\n`)]))))
const code = await readFile('node_modules/pdfjs-dist/build/pdf.mjs', 'utf8')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), source, `--data-dir=${resolve(directory, `data-${Date.now()}`)}`], env })
try {
  const page = await app.firstWindow()
  await page.locator('.canvas-holder canvas').first().waitFor({ timeout: 30000 })
  const worker = await app.evaluate(({ app }) => {
    const names = process.getBuiltinModule('fs').readdirSync(app.getAppPath() + '/out/renderer/assets')
    return '/assets/' + names.find(name => name.startsWith('pdf.worker.min-') && name.endsWith('.mjs'))
  })
  const cdp = await page.context().newCDPSession(page)
  // Only the reference renderer needs an injected test module. The application
  // UI and all performance/selection runs retain their normal CSP.
  await cdp.send('Page.setBypassCSP', { enabled: true })
  await page.evaluate(async path => {
    const session = await window.reader.openPdf(path)
    const result = await window.reader.openPdfRaster('reload-probe', session.value.originalUrl)
    if (!result.ok) throw new Error(result.error)
  }, source)
  await page.reload(); await page.locator('.canvas-holder canvas').first().waitFor({ timeout: 30000 })
  const stale = await page.evaluate(() => window.reader.renderPdfRaster('reload-probe', { id: 'stale-reload', page: 1, scale: 1, width: 100, height: 100, priority: 0 }))
  assert.equal(stale.ok, false, 'reloading the renderer must release previous page raster sessions')
  await page.addScriptTag({ type: 'module', content: code + '\nwindow.pdfReference = {getDocument, GlobalWorkerOptions};' })
  const result = await page.evaluate(async ({ source, copies, worker }) => {
    const unwrap = result => { if (!result.ok) throw new Error(result.error); return result.value }
    const original = unwrap(await window.reader.openPdf(source))
    const { getDocument, GlobalWorkerOptions } = window.pdfReference; GlobalWorkerOptions.workerSrc = worker
    const loading = getDocument({ url: original.originalUrl, cMapUrl: new URL('/pdf-assets/cmaps/', location.href).href, cMapPacked: true, standardFontDataUrl: new URL('/pdf-assets/standard_fonts/', location.href).href, wasmUrl: new URL('/pdf-assets/wasm/', location.href).href, verbosity: 0 })
    const pdf = await loading.promise; const comparisons = []
    unwrap(await window.reader.openPdfRaster('reference-check', original.originalUrl))
    for (let number = 1; number <= pdf.numPages; number++) {
      const reference = await pdf.getPage(number); const viewport = reference.getViewport({ scale: 3 })
      const width = Math.floor(viewport.width); const height = Math.floor(viewport.height)
      const { png } = unwrap(await window.reader.renderPdfRaster('reference-check', { id: `reference-${number}`, page: number, scale: 3, width, height, priority: 0 }))
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(png)], { type: 'image/png' }))
      const actual = document.createElement('canvas'); actual.width = width; actual.height = height
      actual.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
      const expected = document.createElement('canvas'); expected.width = width; expected.height = height
      // Compare RGBA surfaces: Blink's opaque LCD subpixel text differs from
      // portable PNG/Skia grayscale antialiasing even for identical glyphs.
      expected.getContext('2d', { alpha: true, willReadFrequently: true })
      await reference.render({ canvas: expected, viewport, transform: [width / viewport.width, 0, 0, width / viewport.width, 0, 0] }).promise
      const a = actual.getContext('2d').getImageData(0, 0, width, height).data
      const b = expected.getContext('2d').getImageData(0, 0, width, height).data
      let error = 0; let actualInk = 0; let referenceInk = 0
      for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { error += Math.abs(a[i] - b[i]); if (a[i] < 200) actualInk++; if (b[i] < 200) referenceInk++ }
      comparisons.push({ page: number, meanError: error / (width * height * 3), inkRatio: actualInk / referenceInk,
        ...(number === 1 || number === 15 ? { actual: actual.toDataURL(), reference: expected.toDataURL() } : {}) })
      actual.width = 0; actual.height = 0; expected.width = 0; expected.height = 0
    }
    await loading.destroy(); unwrap(await window.reader.closePdfRaster('reference-check'))
    const [a, b] = await Promise.all(copies.map(async path => unwrap(await window.reader.openPdf(path))))
    if (a.originalUrl === b.originalUrl) throw new Error('font isolation fixture must create two independent PDF processes')
    unwrap(await window.reader.openPdfRaster('font-a', a.originalUrl)); unwrap(await window.reader.openPdfRaster('font-b', b.originalUrl))
    const request = id => ({ id, page: 1, scale: 1, width: 300, height: 388, priority: 0 })
    const before = unwrap(await window.reader.renderPdfRaster('font-b', request('font-before'))).png
    unwrap(await window.reader.renderPdfRaster('font-a', request('font-shared')))
    unwrap(await window.reader.closePdfRaster('font-a'))
    const after = unwrap(await window.reader.renderPdfRaster('font-b', request('font-after'))).png
    const fontPreserved = before.length === after.length && before.every((byte, index) => byte === after[index])
    unwrap(await window.reader.closePdfRaster('font-b'))
    return { comparisons, fontPreserved }
  }, { source, copies, worker })
  for (const item of result.comparisons) for (const kind of ['actual', 'reference']) if (item[kind]) {
    await writeFile(resolve(directory, `page-${item.page}-${kind}.png`), Buffer.from(item[kind].split(',')[1], 'base64')); delete item[kind]
  }
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result, null, 2))
  assert(result.fontPreserved, 'closing one PDF process must not alter another PDF using identical embedded fonts')
  for (const item of result.comparisons) {
    assert(item.meanError <= 5, `page ${item.page}: raster error ${item.meanError} exceeds 5/255`)
    assert(item.inkRatio >= .9 && item.inkRatio <= 1.1, `page ${item.page}: rendered content coverage changed: ${item.inkRatio}`)
  }
  console.log(JSON.stringify({ passed: true, pages: result.comparisons.length, fontPreserved: result.fontPreserved }))
} finally { await app.close() }
