import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, FileText, LoaderCircle } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import { positionFromScroll, scrollFromPosition, type PageMetric } from '../../shared/core'
import type { AnnotationAnchor, PaperAnnotation, Position } from '../../shared/types'
import { normalizeSelectionRects } from '../../shared/selection'
import { schedulePdfRender } from './pdf-render-scheduler'
import { PdfPage, type PageSize } from './PdfPage'
import { PdfPageVisibility } from './pdf-page-visibility'
import { activatePdfPane, pdfPerformance, sizeCache } from './pdf-performance'
import { indexPageAnnotations, pdfDocumentCacheKey } from './pdf-page-cache'
import { PdfRasterClient } from './pdf-raster-client'

GlobalWorkerOptions.workerSrc = workerUrl
export interface PaneHandle { goTo(position: Position): void }
export interface TextSelection { quote: string; anchors: AnnotationAnchor[]; x: number; y: number }
interface PaneProps { side: 'left' | 'right'; url: string; zoom: number; initialPosition: Position; language?: string; isTranslation?: boolean; annotations: PaperAnnotation[]; onSelection(selection: TextSelection): void; onAnnotation(id: string): void; onPosition(position: Position): void; onZoom(zoom: number): void }
const emptyAnnotations: PaperAnnotation[] = []
const zoomLevels = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3]

export const PdfPane = memo(forwardRef<PaneHandle, PaneProps>(function PdfPane({ side, url, zoom, initialPosition, language, isTranslation = side === 'right', annotations, onSelection, onAnnotation, onPosition, onZoom }, ref) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [raster, setRaster] = useState<PdfRasterClient | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [error, setError] = useState('')
  const [width, setWidth] = useState(600)
  const [renderZoom, setRenderZoom] = useState(zoom)
  const [currentPage, setCurrentPage] = useState(initialPosition.page)
  const [pageInput, setPageInput] = useState(String(initialPosition.page))
  const container = useRef<HTMLDivElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const baseMetrics = useRef<PageMetric[]>([])
  const zoomAnchor = useRef<{ paper: HTMLElement; x: number; y: number; clientX: number; clientY: number } | null>(null)
  const requestedZoom = useRef(zoom)
  const appliedZoom = useRef(zoom)
  const zoomCallback = useRef(onZoom); zoomCallback.current = onZoom
  const zoomPositionFrame = useRef(0)
  const position = useRef(initialPosition)
  const suppressed = useRef<{ top: number; left: number } | null>(null)
  const callback = useRef(onPosition); callback.current = onPosition
  const metrics = useRef<PageMetric[]>([])
  const [visibility, setVisibility] = useState<PdfPageVisibility | null>(null)
  const visibilityRef = useRef(visibility); visibilityRef.current = visibility
  const annotationIndex = useRef(new Map<number, PaperAnnotation[]>())
  const pageAnnotations = useMemo(() => {
    annotationIndex.current = indexPageAnnotations(annotations, annotationIndex.current)
    return annotationIndex.current
  }, [annotations])
  useEffect(() => {
    if (!container.current) return
    const observer = new PdfPageVisibility(container.current); setVisibility(observer)
    return () => observer.destroy()
  }, [])
  const goTo = useCallback((target: Position) => {
    zoomAnchor.current = null
    const element = container.current
    if (!element || !element.children.length) { position.current = target; return }
    position.current = target
    const top = Math.max(0, Math.min(scrollFromPosition(target, metrics.current), element.scrollHeight - element.clientHeight))
    element.scrollTop = top; suppressed.current = { top: element.scrollTop, left: element.scrollLeft }
    const actual = positionFromScroll(top, metrics.current)
    setCurrentPage(actual.page); setPageInput(String(actual.page))
  }, [])
  useLayoutEffect(() => {
    if (requestedZoom.current === appliedZoom.current) requestedZoom.current = zoom
    appliedZoom.current = zoom
  }, [zoom])
  useEffect(() => {
    if (zoom === renderZoom) return
    const timer = setTimeout(() => setRenderZoom(zoom), 150)
    return () => clearTimeout(timer)
  }, [zoom, renderZoom, url])
  useImperativeHandle(ref, () => ({ goTo }), [goTo])
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = container.current
    if (!element) return
    requestedZoom.current = zoom
    let frame = 0
    let pointer = { clientX: 0, clientY: 0 }
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) { zoomAnchor.current = null; return }
      if (event.deltaY === 0) return
      event.preventDefault()
      const next = event.deltaY < 0
        ? zoomLevels.find(value => value > requestedZoom.current) ?? zoomLevels[zoomLevels.length - 1]
        : [...zoomLevels].reverse().find(value => value < requestedZoom.current) ?? zoomLevels[0]
      if (next === requestedZoom.current) return
      requestedZoom.current = next; pointer = { clientX: event.clientX, clientY: event.clientY }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (requestedZoom.current === appliedZoom.current) return
        const viewport = element.getBoundingClientRect()
        const page = positionFromScroll(element.scrollTop + pointer.clientY - viewport.top, metrics.current).page
        const paper = element.querySelector<HTMLElement>(`[data-page="${page}"] .pdf-paper`)
        if (paper) {
          const bounds = paper.getBoundingClientRect()
          zoomAnchor.current = { paper, ...pointer, x: (pointer.clientX - bounds.left) / bounds.width, y: (pointer.clientY - bounds.top) / bounds.height }
        }
        visibilityRef.current?.scroll(position.current.page, 0)
        zoomCallback.current(requestedZoom.current)
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel); cancelAnimationFrame(frame); cancelAnimationFrame(zoomPositionFrame.current) }
  }, [url])
  useEffect(() => {
    let cancelled = false; let cancelBackground = () => {}
    zoomAnchor.current = null
    position.current = initialPosition
    setPdf(null); setSizes([]); setError('')
    const raster = pdfPerformance.worker ? new PdfRasterClient(url) : null; setRaster(raster)
    const loading = getDocument({ url, cMapUrl: new URL('/pdf-assets/cmaps/', location.href).href, cMapPacked: true, standardFontDataUrl: new URL('/pdf-assets/standard_fonts/', location.href).href, wasmUrl: new URL('/pdf-assets/wasm/', location.href).href, verbosity: 0 })
    void loading.promise.then(async document => {
      const key = pdfDocumentCacheKey(url, document.fingerprints)
      const cached = sizeCache.get(key)
      if (cached) { if (!cancelled) { setSizes(cached); setPdf(document) }; return }
      const first = await document.getPage(1)
      if (cancelled) return
      const viewport = first.getViewport({ scale: 1 })
      const dimensions: PageSize[] = Array.from({ length: document.numPages }, () => ({ width: viewport.width, height: viewport.height }))
      const target = Math.min(document.numPages, Math.max(1, initialPosition.page))
      if (target > 1) {
        const page = await document.getPage(target)
        const size = page.getViewport({ scale: 1 }); dimensions[target - 1] = { width: size.width, height: size.height }
      }
      if (cancelled) return
      setSizes([...dimensions]); setPdf(document)
      // First paint uses necessary dimensions; complete the table off the critical path.
      for (let n = 1; n <= document.numPages; n += 8) {
        await new Promise<void>(resolve => { cancelBackground = schedulePdfRender(resolve, { priority: 4, kind: 'background', isCurrent: () => !cancelled }) })
        if (cancelled) return
        for (let i = n; i < Math.min(n + 8, document.numPages + 1); i++) {
          const page = await document.getPage(i)
          if (cancelled) return
          const size = page.getViewport({ scale: 1 }); dimensions[i - 1] = { width: size.width, height: size.height }
        }
      }
      if (!cancelled) { sizeCache.set(key, dimensions, dimensions.length * 32); setSizes([...dimensions]) }
    }).catch(() => { if (!cancelled) setError('PDF 显示失败，请检查文件后重新打开。') })
    return () => { cancelled = true; cancelBackground(); raster?.close(); void loading.destroy() }
  }, [url])
  useLayoutEffect(() => {
    // Measure only the committed page layout; wheel previews reuse these metrics.
    baseMetrics.current = Array.from(content.current?.querySelectorAll<HTMLDivElement>('.page-slot') ?? []).map(page => ({ top: page.offsetTop, height: page.offsetHeight }))
  }, [width, renderZoom, pdf, sizes])
  useLayoutEffect(() => {
    const element = container.current; const wrapper = preview.current; const pages = content.current
    if (!element || !wrapper || !pages || !pdf || !baseMetrics.current.length) return
    const ratio = zoom / renderZoom
    const last = baseMetrics.current[baseMetrics.current.length - 1]
    const gap = parseFloat(getComputedStyle(pages.lastElementChild!).marginBottom) || 0
    wrapper.style.height = `${(last.top + last.height + gap) * ratio}px`
    const top = wrapper.offsetTop
    metrics.current = baseMetrics.current.map(page => ({ top: top + page.top * ratio, height: page.height * ratio }))
    const anchor = zoomAnchor.current
    if (anchor?.paper.isConnected) {
      const bounds = anchor.paper.getBoundingClientRect()
      element.scrollLeft += bounds.left + anchor.x * bounds.width - anchor.clientX
      element.scrollTop += bounds.top + anchor.y * bounds.height - anchor.clientY
      const next = positionFromScroll(element.scrollTop, metrics.current)
      position.current = next; suppressed.current = { top: element.scrollTop, left: element.scrollLeft }
      setCurrentPage(next.page); setPageInput(String(next.page))
      cancelAnimationFrame(zoomPositionFrame.current)
      // Linked panes must finish measuring their new layout before receiving this position.
      zoomPositionFrame.current = requestAnimationFrame(() => { zoomPositionFrame.current = 0; callback.current(position.current) })
      if (zoom === renderZoom) zoomAnchor.current = null
    } else goTo(position.current)
  }, [width, zoom, renderZoom, pdf, sizes, goTo])
  useEffect(() => {
    const element = container.current
    if (!element) return
    let frame = 0; let lastTop = element.scrollTop
    const scroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = positionFromScroll(element.scrollTop, metrics.current)
        visibilityRef.current?.scroll(next.page, Math.sign(element.scrollTop - lastTop)); lastTop = element.scrollTop
        if (suppressed.current !== null && Math.abs(element.scrollTop - suppressed.current.top) < 2 && Math.abs(element.scrollLeft - suppressed.current.left) < 2) { suppressed.current = null; return }
        suppressed.current = null
        zoomAnchor.current = null
        position.current = next; setCurrentPage(next.page); setPageInput(String(next.page)); callback.current(next)
      })
    }
    element.addEventListener('scroll', scroll, { passive: true })
    return () => { element.removeEventListener('scroll', scroll); cancelAnimationFrame(frame) }
  }, [])
  const jump = (page: number) => {
    if (!pdf) return
    const next = { page: Math.max(1, Math.min(pdf.numPages, page || 1)), fraction: 0 }
    goTo(next); callback.current(next)
  }
  const label = language ?? (side === 'left' ? '英文' : '中文')
  const pages = useMemo(() => pdf && sizes.map((size, index) => <PdfPage key={index} pdf={pdf} raster={raster} documentKey={pdfDocumentCacheKey(url, pdf.fingerprints)} number={index + 1} scale={Math.max(0.1, Math.min(1000, width - 64) / size.width) * renderZoom} size={size} visibility={visibility} side={side} annotations={pageAnnotations.get(index + 1) ?? emptyAnnotations} />), [pdf, raster, sizes, width, renderZoom, pageAnnotations, visibility, side, url])
  const pageWidth = useMemo(() => Math.max(0, ...sizes.map(size => Math.max(size.width * .1, Math.min(1000, width - 64)) * renderZoom)), [sizes, width, renderZoom])
  const previewRatio = zoom / renderZoom
  const contentWidth = Math.max(width / previewRatio, pageWidth)
  const collectSelection = () => {
    const selection = window.getSelection()
    const element = container.current
    if (!selection || !element || selection.isCollapsed || !selection.rangeCount || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return
    const range = selection.getRangeAt(0)
    const fragments: string[] = []
    const anchors: AnnotationAnchor[] = []
    for (const slot of element.querySelectorAll<HTMLElement>('.page-slot')) {
      const paper = slot.querySelector<HTMLElement>('.pdf-paper')
      const layer = slot.querySelector<HTMLElement>('.textLayer')
      if (!paper || !layer || !range.intersectsNode(layer)) continue
      const rectangles: DOMRect[] = []
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
      const pageFragments: string[] = []
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (!range.intersectsNode(node) || !node.textContent?.trim()) continue
        const selected = document.createRange()
        selected.selectNodeContents(node)
        if (range.startContainer === node) selected.setStart(node, range.startOffset)
        if (range.endContainer === node) selected.setEnd(node, range.endOffset)
        if (selected.collapsed) continue
        rectangles.push(...Array.from(selected.getClientRects()))
        pageFragments.push(selected.toString())
      }
      const rects = normalizeSelectionRects(paper.getBoundingClientRect(), rectangles)
      if (rects.length) { anchors.push({ page: Number(slot.dataset.page), rects }); fragments.push(pageFragments.join(' ')) }
    }
    const quote = fragments.join('\n').trim()
    if (!quote) return
    const bounds = range.getBoundingClientRect()
    if (anchors.length) onSelection({ quote, anchors, x: Math.max(15, Math.min(window.innerWidth - 370, bounds.left + bounds.width / 2 - 160)), y: Math.min(window.innerHeight - 65, bounds.bottom + 9) })
  }
  const clicked = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!window.getSelection()?.isCollapsed) return
    const paper = (event.target as HTMLElement).closest<HTMLElement>('.pdf-paper')
    const slot = paper?.closest<HTMLElement>('.page-slot')
    if (!paper || !slot) return
    const bounds = paper.getBoundingClientRect(); const x = (event.clientX - bounds.left) / bounds.width; const y = (event.clientY - bounds.top) / bounds.height
    const match = annotations.find(annotation => annotation.anchors.some(anchor => anchor.page === Number(slot.dataset.page) && anchor.rects.some(rect => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)))
    if (match) onAnnotation(match.id)
  }
  return <section className={`pdf-pane ${side}`} data-side={side} onWheelCapture={() => activatePdfPane(side)} onPointerDownCapture={() => activatePdfPane(side)} onKeyDownCapture={() => activatePdfPane(side)} aria-label={`${label}阅读栏`}>
    <div className="pane-toolbar">
      <div className="pane-language"><span className="language-tag">{label === '英文' ? 'EN' : label === '中文' ? '中' : '文'}</span><span>{label === '原文' ? label : `${label}${isTranslation ? '译文' : '原文'}`}</span><span className="pane-note">PDF</span></div>
      <div className="pane-controls">
        <select aria-label={`${label}缩放`} title="按住 Ctrl 并滚动鼠标滚轮，以鼠标为中心缩放页面" value={zoom} onChange={event => { zoomAnchor.current = null; onZoom(Number(event.target.value)) }}>
          {zoomLevels.map(value => <option key={value} value={value}>{value === 1 ? '适应宽度' : `${Math.round(value * 100)}% 宽度`}</option>)}
        </select>
        <span className="toolbar-separator" />
        <button className="icon-button" aria-label={`上一页（${label}）`} disabled={currentPage <= 1} onClick={() => jump(currentPage - 1)}><ChevronLeft size={16} /></button>
        <form onSubmit={event => { event.preventDefault(); jump(Number(pageInput)) }}><input aria-label={`${label}页码`} value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onBlur={() => setPageInput(String(currentPage))} /><span>/ {pdf?.numPages ?? '—'}</span></form>
        <button className="icon-button" aria-label={`下一页（${label}）`} disabled={!pdf || currentPage >= pdf.numPages} onClick={() => jump(currentPage + 1)}><ChevronRight size={16} /></button>
      </div>
    </div>
    <div ref={container} className="pdf-scroll" tabIndex={0} aria-label={`${label} PDF 页面`} onMouseUp={() => requestAnimationFrame(collectSelection)} onKeyUp={event => { if (event.shiftKey) requestAnimationFrame(collectSelection) }} onClick={clicked}>
      {!pdf && !error && <div className="pane-loading"><LoaderCircle className="spin" size={24} /><span>正在载入论文</span></div>}
      {error && <div className="pane-loading"><FileText size={26} /><span>{error}</span></div>}
      <div ref={preview} className="pdf-pages" style={{ width: contentWidth * previewRatio }}>
        <div ref={content} className="pdf-pages-content" style={{ width: contentWidth, transform: previewRatio === 1 ? undefined : `scale(${previewRatio})` }}>{pages}</div>
      </div>
    </div>
  </section>
}))
