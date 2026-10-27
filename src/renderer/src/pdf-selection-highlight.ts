import { normalizeSelectionRects } from '../../shared/selection'

export function selectedTextFragments(layer: HTMLElement, range: Range) {
  const rectangles: DOMRect[] = []; const fragments: string[] = []
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node) || !node.textContent) continue
    const selected = document.createRange()
    selected.selectNodeContents(node)
    if (range.startContainer === node) selected.setStart(node, range.startOffset)
    if (range.endContainer === node) selected.setEnd(node, range.endOffset)
    if (selected.collapsed) continue
    rectangles.push(...Array.from(selected.getClientRects()))
    if (selected.toString().trim()) fragments.push(selected.toString())
  }
  return { rectangles, quote: fragments.join(' ') }
}

// Paint separately from PDF.js's transformed spans so word gaps and overlapping
// font fragments don't leave seams. The browser still owns the actual selection.
export class PdfSelectionHighlight {
  private frame = 0
  private painted = new Set<HTMLElement>()
  private resize: ResizeObserver
  constructor(private root: HTMLElement) {
    document.addEventListener('selectionchange', this.schedule)
    document.addEventListener('pointerup', this.schedule)
    this.resize = new ResizeObserver(this.schedule); this.resize.observe(root)
  }
  private schedule = () => {
    if (!this.frame) this.frame = requestAnimationFrame(this.paint)
  }
  private paint = () => {
    this.frame = 0
    const selection = window.getSelection()
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
    const next = new Set<HTMLElement>()
    if (range) for (const paper of this.root.querySelectorAll<HTMLElement>('.pdf-paper')) {
      const layer = paper.querySelector<HTMLElement>('.textLayer')
      const overlay = paper.querySelector<HTMLElement>('.text-selection-layer')
      if (!layer || !overlay || !range.intersectsNode(layer)) continue
      const { rectangles } = selectedTextFragments(layer, range)
      const rects = normalizeSelectionRects(paper.getBoundingClientRect(), rectangles, Number(layer.dataset.mainRotation ?? 0))
      if (!rects.length) continue
      const marks = rects.map(rect => {
        const mark = document.createElement('span')
        mark.style.cssText = `left:${rect.x * 100}%;top:${rect.y * 100}%;width:${rect.width * 100}%;height:${rect.height * 100}%`
        return mark
      })
      overlay.replaceChildren(...marks); layer.classList.add('selectionRendering'); next.add(layer)
    }
    for (const layer of this.painted) if (!next.has(layer)) {
      layer.classList.remove('selectionRendering')
      layer.parentElement?.querySelector('.text-selection-layer')?.replaceChildren()
    }
    this.painted = next
  }
  destroy() {
    document.removeEventListener('selectionchange', this.schedule)
    document.removeEventListener('pointerup', this.schedule)
    this.resize.disconnect(); cancelAnimationFrame(this.frame)
    for (const layer of this.painted) {
      layer.classList.remove('selectionRendering')
      layer.parentElement?.querySelector('.text-selection-layer')?.replaceChildren()
    }
    this.painted.clear()
  }
}
