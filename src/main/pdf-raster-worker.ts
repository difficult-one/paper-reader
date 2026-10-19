import { parentPort, workerData, threadId } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas'
import type { PdfRasterRequest } from '../shared/pdf-raster'
import type { PDFPageProxy } from 'pdfjs-dist'
import { encodeRasterPng } from './pdf-raster-png.ts'
import { PdfDecompressionStream } from './pdf-decompression-stream.ts'

// PDF.js's font-loading interface backed by Skia, wholly outside the UI thread.
// Production uses a process per PDF to isolate the process-global font registry.
// Thread prefixes also keep the standalone Node test adapter's aliases distinct.
const names = new Map<string, string>()
let fontTime = 0
class RasterFontFace {
  readonly family: string
  readonly loaded: Promise<this>
  readonly key: ReturnType<typeof GlobalFonts.register> = null
  constructor(family: string, source: Uint8Array | string) {
    const started = performance.now()
    this.family = family
    if (typeof source === 'string') {
      const available = GlobalFonts.families.map(font => font.family)
      const candidates = [...source.matchAll(/local\(["']?([^"')]+)["']?\)/g)].map(match => match[1])
      const found = available.find(font => candidates.some(candidate => candidate.toLowerCase() === font.toLowerCase()))
      if (found) names.set(family, found)
    } else {
      const alias = `r${threadId}_${family}`
      this.key = GlobalFonts.register(Buffer.from(source), alias)
      if (this.key) names.set(family, alias)
    }
    this.loaded = names.has(family) ? Promise.resolve(this) : Promise.reject(new Error('PDF 字体加载失败。'))
    fontTime += performance.now() - started
  }
  load() { return this.loaded }
}
Object.assign(globalThis, { FontFace: RasterFontFace, DecompressionStream: PdfDecompressionStream })
const fonts = { add(font: RasterFontFace) { return font }, delete(font: RasterFontFace) {
  names.delete(font.family)
  // Lanes for one PDF share native keys; deleting one lane's font can remove
  // another lane's alias. The enclosing PDF process reclaims them together.
  if (font.key && !workerData.sharedFonts) GlobalFonts.remove(font.key)
  return true
} }
function drawingContext(canvas: Canvas, opaque = false) {
  const context = canvas.getContext('2d', { alpha: !opaque }); const methods = new Map<PropertyKey, unknown>()
  return new Proxy(context, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (!methods.has(property)) methods.set(property, value.bind(target))
      return methods.get(property)
    },
    set(target, property, value) {
      if (property === 'font') value = String(value).replace(/\bg_[\w]+\b/g, name => names.get(name) ?? name)
      return Reflect.set(target, property, value, target)
    },
  })
}
class RasterCanvasFactory {
  create(width: number, height: number) { const canvas = createCanvas(width, height); return { canvas, context: drawingContext(canvas) } }
  reset(entry: { canvas: Canvas }, width: number, height: number) { entry.canvas.width = width; entry.canvas.height = height }
  destroy(entry: { canvas: Canvas | null; context: unknown }) { if (entry.canvas) { entry.canvas.width = 1; entry.canvas.height = 1 }; entry.canvas = null; entry.context = null }
}

const queue = new Map<string, PdfRasterRequest & { queued: number }>()
const input = workerData
const send = (message: unknown, transfer: ArrayBuffer[] = []) => parentPort!.postMessage(message, transfer)
let active: { id: string; cancelled: boolean; cancel?: () => void } | null = null
let pumping = false
let closing = false
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const loading = getDocument({ data: new Uint8Array(await readFile(input.path)), verbosity: 0, disableFontFace: false, useSystemFonts: true,
  ownerDocument: { fonts } as unknown as HTMLDocument, CanvasFactory: RasterCanvasFactory,
  cMapUrl: join(input.assets, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(input.assets, 'standard_fonts') + '/', wasmUrl: join(input.assets, 'wasm') + '/' })
const pdf = await loading.promise
send({ type: 'ready' })
async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (queue.size) {
      const now = performance.now()
      const request = [...queue.values()].sort((a, b) => (a.priority - Math.floor((now - a.queued) / 500)) - (b.priority - Math.floor((now - b.queued) / 500)))[0]
      queue.delete(request.id)
      const started = performance.now()
      const initialFontTime = fontTime
      let firstContinueMs: number | undefined
      const current = active = { id: request.id, cancelled: false } as NonNullable<typeof active>
      let canvas: Canvas | undefined
      let page: PDFPageProxy | undefined
      try {
        page = await pdf.getPage(request.page)
        if (current.cancelled) continue
        const viewport = page.getViewport({ scale: request.scale }); const ratio = request.width / viewport.width
        canvas = createCanvas(request.width, request.height)
        const render = page.render({ canvas: null, canvasContext: drawingContext(canvas, true) as unknown as CanvasRenderingContext2D, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        current.cancel = () => render.cancel()
        render.onContinue = (resume: () => void) => { firstContinueMs ??= performance.now() - started; setImmediate(() => { if (current.cancelled) render.cancel(); else resume() }) }
        await render.promise
        if (current.cancelled) continue
        const rendered = performance.now()
        const png = Uint8Array.from(await encodeRasterPng(canvas))
        if (!current.cancelled) send({ id: request.id, png, ...(request.trace ? { timings: { queueMs: started - request.queued, renderMs: rendered - started, encodeMs: performance.now() - rendered, fontMs: fontTime - initialFontTime, firstContinueMs } } : {}) }, [png.buffer])
      } catch (error) {
        if (!current.cancelled) send({ id: request.id, error: error instanceof Error ? error.message : 'PDF 绘制失败。' })
      } finally {
        if (canvas) { canvas.width = 1; canvas.height = 1 }
        page?.cleanup()
        active = null
      }
    }
  } finally { pumping = false; if (closing) await finishClose() }
}
async function finishClose() { await loading.destroy(); parentPort!.close() }
const receive = (message: any) => {
  if (message.type === 'render' && !closing) { queue.set(message.id, { ...message, queued: performance.now() }); void pump() }
  if (message.type === 'priority') { const request = queue.get(message.id); if (request) request.priority = message.priority }
  if (message.type === 'cancel') { queue.delete(message.id); const current = active; if (current && current.id === message.id) { current.cancelled = true; current.cancel?.() } }
  if (message.type === 'close') { closing = true; queue.clear(); if (active) { active.cancelled = true; active.cancel?.() }; if (!pumping) void finishClose() }
}
parentPort!.on('message', receive)
