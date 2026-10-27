import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import type { PaperAnnotation } from '../../shared/types'
import { highlightColors } from '../../shared/selection'
import { schedulePdfRender, type PdfWork } from './pdf-render-scheduler'
import { rasterDimensions } from './pdf-page-cache'
import { activePdfPane, pdfPerformance, pdfStats, rasterCache, textCache } from './pdf-performance'
import { PdfPageVisibility, type PageVisibility } from './pdf-page-visibility'
import type { PdfRasterClient } from './pdf-raster-client'

export interface PageSize { width: number; height: number }
interface Display { canvas: HTMLCanvasElement; scale: number }

export const PdfPage = memo(function PdfPage({ pdf, raster, documentKey, number, scale, size, visibility, side, annotations }: {
  pdf: PDFDocumentProxy; raster: PdfRasterClient | null; documentKey: string; number: number; scale: number; size: PageSize; visibility: PdfPageVisibility | null; side: string; annotations: PaperAnnotation[]
}) {
  const slot = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const display = useRef<Display | null>(null)
  const textScale = useRef(0)
  const currentScale = useRef(scale); currentScale.current = scale
  const generation = useRef(0)
  const [state, setState] = useState<PageVisibility>({ near: false, visible: false, moving: false, selected: false, dragging: false })
  const current = useRef(state); current.current = state
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const rasterReady = !state.moving || (!display.current && state.visible)
  const work = (signal: AbortSignal, version: number, kind: PdfWork['kind'] = 'canvas'): PdfWork => ({
    signal, isCurrent: () => version === generation.current,
    document: documentKey, page: number, generation: version, kind,
    priority: () => !pdfPerformance.priority ? 2 : current.current.visible ? (activePdfPane === side ? 0 : 1)
      : (number - (visibility?.page ?? number)) * (visibility?.direction ?? 1) >= 0 ? 2 : 3,
  })
  useEffect(() => {
    if (slot.current && visibility) return visibility.observe(slot.current, setState)
  }, [visibility])
  useEffect(() => { raster?.prioritize(number) }, [raster, number, state.visible, state.moving, state.near])
  useEffect(() => () => {
    const previous = display.current; display.current = null
    if (previous) rasterCache.delete(previous.canvas)
  }, [pdf])

  useEffect(() => {
    if (!state.near || state.selected) return
    const old = display.current
    if (old?.scale === scale) { rasterCache.get(old.canvas); pdfStats.cacheHits++; return }
    if (!rasterReady) return
    const abort = new AbortController(); const version = ++generation.current
    let render: RenderTask | undefined; let canvas: HTMLCanvasElement | undefined; let complete = false
    let renderPromise: Promise<unknown> | undefined
    let cancel = () => {}
    const start = async () => {
      const page = await pdf.getPage(number)
      if (abort.signal.aborted) return
      const options = work(abort.signal, version)
      cancel = schedulePdfRender(() => {
        const viewport = page.getViewport({ scale })
        // Leave room for replacement buffers even when both panes pin visible pages.
        const available = Math.min(rasterCache.budget / 8, rasterCache.availableBytes(), 32_000_000)
        const dimensions = rasterDimensions(viewport.width, viewport.height, window.devicePixelRatio, available)
        canvas = document.createElement('canvas')
        const candidate = canvas
        if (!rasterCache.set(canvas, canvas, dimensions.width * dimensions.height * 4,
          () => !complete || current.current.visible || current.current.selected || Boolean(visibility?.isPinned(slot.current)),
          () => {
            candidate.remove(); candidate.width = 0; candidate.height = 0
            if (display.current?.canvas === candidate) {
              display.current = null; text.current?.replaceChildren(); textScale.current = 0; pdfStats.evictions++
              setRevision(value => value + 1)
            }
          })) {
          // Retry after in-flight allocations settle; never exceed the shared budget.
          retry = setTimeout(() => { if (!abort.signal.aborted) void start().catch(failed) }, pdfPerformance.settleMs)
          return
        }
        canvas.width = dimensions.width; canvas.height = dimensions.height
        canvas.setAttribute('aria-label', `第 ${number} 页`); canvas.dataset.quality = 'clear'; canvas.dataset.pdfRaster = 'true'
        if (raster) {
          renderPromise = raster.paint(canvas, { page: number, scale, width: dimensions.width, height: dimensions.height, priority: typeof options.priority === 'function' ? options.priority() : options.priority ?? 2 }, options)
        } else {
          render = page.render({ canvas, viewport, transform: [dimensions.ratio, 0, 0, dimensions.ratio, 0, 0] })
          render.onContinue = (resume: () => void) => { cancel = schedulePdfRender(resume, work(abort.signal, version)) }
          renderPromise = render.promise
        }
        pdfStats.canvasRenders++
        void renderPromise.then(() => {
          complete = true
          if (abort.signal.aborted || version !== generation.current) { rasterCache.delete(candidate); return }
          const previous = display.current
          display.current = { canvas: candidate, scale }
          host.current?.replaceChildren(candidate)
          if (previous) rasterCache.delete(previous.canvas)
          setError(''); setRevision(value => value + 1)
        }, err => { complete = true; rasterCache.delete(candidate); failed(err) })
      }, { ...options, isReady: () => !raster || raster.canStart(typeof options.priority === 'function' ? options.priority() : options.priority ?? 2) })
    }
    const failed = (err: unknown) => { if (!abort.signal.aborted && (err as Error)?.name !== 'RenderingCancelledException') setError('此页显示失败，请重新打开文件。') }
    let retry: ReturnType<typeof setTimeout> | undefined
    // Layout updates immediately using the retained canvas; exact raster waits for stability.
    const timer = setTimeout(() => void start().catch(failed), old && old.scale !== scale ? pdfPerformance.settleMs : 0)
    return () => {
      clearTimeout(timer); clearTimeout(retry); abort.abort(); cancel(); render?.cancel()
      if (canvas && !complete) {
        const candidate = canvas
        const release = () => { complete = true; rasterCache.delete(candidate) }
        if (renderPromise) void renderPromise.then(release, release); else release()
      }
    }
  }, [pdf, number, scale, state.near, rasterReady, state.selected, revision])

  useEffect(() => {
    const shown = display.current
    // PDF text coordinates remain valid at every zoom. Keep the nodes and scale
    // their container instead of rebuilding thousands of spans after each tick.
    if (!state.visible || state.selected || (state.moving && pdfPerformance.deferText) || !shown || shown.scale !== scale || textScale.current) return
    const abort = new AbortController(); const version = generation.current
    let layer: TextLayer | undefined; let cancel = () => {}
    const key = `${documentKey}:${number}`
    void (async () => {
      const page = await pdf.getPage(number)
      if (abort.signal.aborted) return
      cancel = schedulePdfRender(() => {
        void (async () => {
          let content = textCache.get(key)
          if (!content) {
            content = await page.getTextContent()
            if (abort.signal.aborted) return
            const bytes = JSON.stringify(content).length * 2
            textCache.set(key, content, bytes)
          }
          if (abort.signal.aborted) return
          cancel = schedulePdfRender(() => {
            const element = document.createElement('div'); element.className = 'textLayer'
            element.style.setProperty('--total-scale-factor', String(scale))
            element.style.setProperty('--scale-round-x', '1px'); element.style.setProperty('--scale-round-y', '1px')
            layer = new TextLayer({ textContentSource: content, container: element, viewport: page.getViewport({ scale }) })
            pdfStats.textRenders++
            void layer.render().then(() => {
              if (abort.signal.aborted || current.current.selected || visibility?.isPinned(slot.current) || !text.current) return
              text.current.replaceChildren(...Array.from(element.childNodes))
              text.current.style.cssText = element.style.cssText
              text.current.dataset.mainRotation = element.dataset.mainRotation ?? '0'
              textScale.current = scale
              const ratio = currentScale.current / scale
              text.current.style.transformOrigin = '0 0'; text.current.style.scale = ratio === 1 ? '' : String(ratio)
            }).catch(failed)
          }, work(abort.signal, version, 'text'))
        })().catch(failed)
      }, work(abort.signal, version, 'text'))
    })().catch(failed)
    function failed(err: unknown) { if (!abort.signal.aborted && (err as Error)?.name !== 'AbortException') setError('此页文字层显示失败，请重新打开文件。') }
    return () => { abort.abort(); cancel(); layer?.cancel() }
  }, [pdf, number, scale, state.visible, state.moving, state.selected, revision])

  useLayoutEffect(() => {
    // Changing a text layer's transform during a native drag resets Blink's
    // selection anchor. PdfPane also retains its outer preview until release.
    if (!text.current || !textScale.current || visibility?.isDragging(slot.current)) return
    const ratio = scale / textScale.current
    text.current.style.transformOrigin = '0 0'; text.current.style.scale = ratio === 1 ? '' : String(ratio)
  }, [scale, state.dragging])
  return <div className="page-slot" ref={slot} data-page={number} style={{ width: size.width * scale, height: size.height * scale + 30 }}>
    <div className="pdf-paper" style={{ width: size.width * scale, height: size.height * scale }}>
      <div ref={host} className="canvas-holder" />
      <div ref={text} className="textLayer" />
      <div className="text-selection-layer" aria-hidden="true" />
      <div className="annotation-layer">{(state.near || state.visible || state.selected) && annotations.flatMap(annotation => annotation.anchors.filter(anchor => anchor.page === number).flatMap(anchor => anchor.rects.map((rect, index) => <span key={`${annotation.id}-${index}`} data-annotation={annotation.id} className="highlight-mark" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, backgroundColor: highlightColors[annotation.color] }} />)))}</div>
      {error && <div className="page-error">{error}</div>}
    </div>
    <div className="page-caption">{number}</div>
  </div>
})
