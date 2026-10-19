import type { PdfRasterRequest, PdfRasterResult } from '../../shared/pdf-raster'
import { schedulePdfRender, type PdfWork } from './pdf-render-scheduler'

const aborted = () => new DOMException('PDF 绘制已取消。', 'AbortError')
interface RasterTrace { owner: string; document?: string; page: number; width: number; height: number; created: number; sent?: number; received?: number; decoded?: number; drawn?: number; ended?: number; aborted?: boolean; worker?: PdfRasterResult['timings']; priorities: { time: number; priority: number }[] }
const tracing = typeof location !== 'undefined' && new URLSearchParams(location.search).has('pdf-raster-trace')
const traces: RasterTrace[] = []
if (tracing) Object.assign(window, { __pdfRasterTimings: traces })
export class PdfRasterClient {
  private owner = crypto.randomUUID()
  private ready: Promise<void>
  private initialized = false
  private closed = false
  private pending = new Map<string, { page: number; priority(): number; sent: number; trace?: RasterTrace }>()
  constructor(url: string) {
    this.ready = window.reader.openPdfRaster(this.owner, url).then(result => { if (!result.ok) throw new Error(result.error) }).finally(() => { this.initialized = true })
    // A document can close before its first visible page requests a raster.
    void this.ready.catch(() => {})
  }
  async paint(canvas: HTMLCanvasElement, request: Omit<PdfRasterRequest, 'id'>, work: PdfWork) {
    const trace: RasterTrace | undefined = tracing && traces.length < 10000 ? { owner: this.owner, document: work.document, page: request.page, width: request.width, height: request.height, created: performance.now(), priorities: [] } : undefined
    if (trace) traces.push(trace)
    await this.ready
    if (work.signal?.aborted) throw aborted()
    const id = crypto.randomUUID()
    const priority = () => typeof work.priority === 'function' ? work.priority() : work.priority ?? request.priority
    const initialPriority = priority()
    this.pending.set(id, { page: request.page, priority, sent: initialPriority, trace })
    if (trace) { trace.sent = performance.now(); trace.priorities.push({ time: trace.sent, priority: initialPriority }) }
    const cancel = () => { void window.reader.cancelPdfRaster(this.owner, id) }
    work.signal?.addEventListener('abort', cancel, { once: true })
    let bitmap: ImageBitmap | undefined
    try {
      const result = await window.reader.renderPdfRaster(this.owner, { id, ...request, priority: initialPriority, ...(trace ? { trace: true } : {}) })
      this.pending.delete(id)
      if (trace) { trace.received = performance.now(); if (result.ok) trace.worker = result.value.timings }
      if (work.signal?.aborted) throw aborted()
      if (!result.ok) throw new Error(result.error)
      bitmap = await createImageBitmap(new Blob([Uint8Array.from(result.value.png)], { type: 'image/png' }))
      if (trace) trace.decoded = performance.now()
      if (work.signal?.aborted) throw aborted()
      await new Promise<void>((resolve, reject) => {
        const stop = () => { cancelDraw(); reject(aborted()) }
        const cancelDraw = schedulePdfRender(() => {
          work.signal?.removeEventListener('abort', stop)
          try { canvas.getContext('2d', { alpha: false })!.drawImage(bitmap!, 0, 0); if (trace) trace.drawn = performance.now(); resolve() } catch (error) { reject(error) }
        }, work)
        work.signal?.addEventListener('abort', stop, { once: true })
      })
    } finally { if (trace) { trace.ended = performance.now(); trace.aborted = Boolean(work.signal?.aborted) }; this.pending.delete(id); work.signal?.removeEventListener('abort', cancel); bitmap?.close() }
  }
  prioritize(page: number) {
    for (const [id, request] of this.pending) if (request.page === page) {
      const priority = request.priority()
      if (priority !== request.sent) { request.sent = priority; request.trace?.priorities.push({ time: performance.now(), priority }); void window.reader.prioritizePdfRaster(this.owner, id, priority) }
    }
  }
  canStart(priority = 2) {
    if (!this.initialized || this.closed || this.pending.size >= 2) return false
    // A neighboring page must not contend with a visible page's first paint.
    // Both lanes remain available when two pages are actually visible.
    if (priority > 1) for (const request of this.pending.values()) if (request.priority() <= 1) return false
    return true
  }
  close() { this.closed = true; void window.reader.closePdfRaster(this.owner) }
}
