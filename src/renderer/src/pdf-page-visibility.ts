export interface PageVisibility { near: boolean; visible: boolean; moving: boolean; selected: boolean; dragging: boolean }
interface Watched { state: PageVisibility; notify(state: PageVisibility): void }
export class PdfPageVisibility {
  private pages = new Map<Element, Watched>()
  private near: IntersectionObserver
  private viewport: IntersectionObserver
  private timer: ReturnType<typeof setTimeout> | undefined
  private moving = false
  private dragging: Element | null = null
  private dragAnchor: { node: Node; offset: number; left: number; top: number; relocated: boolean } | null = null
  direction = 1
  page = 1
  constructor(private root: HTMLElement, private settleMs = 130) {
    const update = (field: 'near' | 'visible', entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        const watched = this.pages.get(entry.target)
        if (watched && watched.state[field] !== entry.isIntersecting) {
          watched.state = { ...watched.state, [field]: entry.isIntersecting }; watched.notify(watched.state)
        }
      }
    }
    this.near = new IntersectionObserver(entries => update('near', entries), { root, rootMargin: '4000px 0px' })
    this.viewport = new IntersectionObserver(entries => update('visible', entries), { root })
    document.addEventListener('selectionchange', this.selection)
    root.addEventListener('pointerdown', this.pointerDown)
    root.addEventListener('mousedown', this.mouseDown)
    document.addEventListener('pointerup', this.pointerEnd)
    document.addEventListener('pointercancel', this.pointerEnd)
    document.addEventListener('mousemove', this.mouseMove, true)
  }
  observe(element: Element, notify: (state: PageVisibility) => void) {
    this.pages.set(element, { state: { near: false, visible: false, moving: this.moving, selected: false, dragging: false }, notify })
    this.near.observe(element); this.viewport.observe(element)
    return () => { this.pages.delete(element); this.near.unobserve(element); this.viewport.unobserve(element) }
  }
  scroll(page: number, direction: number) {
    this.page = page; this.direction = direction || this.direction
    if (!this.moving) { this.moving = true; this.motion(true) }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.moving = false; this.motion(false) }, this.settleMs)
  }
  private motion(moving: boolean) {
    for (const watched of this.pages.values()) {
      watched.state = { ...watched.state, moving }
      if (watched.state.near || watched.state.selected) watched.notify(watched.state)
    }
  }
  private selection = () => {
    const selection = window.getSelection()
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
    for (const [element, watched] of this.pages) {
      const dragging = element === this.dragging
      const selected = dragging || Boolean(range?.intersectsNode(element))
      if (selected !== watched.state.selected || dragging !== watched.state.dragging) { watched.state = { ...watched.state, selected, dragging }; watched.notify(watched.state) }
    }
  }
  isPinned(element: Element | null) {
    if (!element) return false
    if (element === this.dragging) return true
    const selection = window.getSelection()
    return Boolean(selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(element))
  }
  isDragging(element: Element | null) { return Boolean(element && element === this.dragging) }
  private pointerDown = (event: Event) => {
    const target = event.target as Element
    const layer = target.closest?.('.textLayer')
    if (!layer) return
    const page = target.closest('.page-slot')
    if (page && this.pages.has(page)) {
      this.dragging = page; this.selection()
      const mouse = event as PointerEvent
      const caret = document.caretRangeFromPoint?.(mouse.clientX, mouse.clientY)
      if (mouse.button === 0 && !mouse.shiftKey && caret && layer.contains(caret.startContainer)) {
        const bounds = this.root.getBoundingClientRect()
        this.dragAnchor = { node: caret.startContainer, offset: caret.startOffset, left: bounds.left, top: bounds.top, relocated: false }
      }
    }
  }
  private mouseMove = (event: MouseEvent) => {
    const anchor = this.dragAnchor
    if (!anchor || !(event.buttons & 1) || !anchor.node.isConnected) return
    const bounds = this.root.getBoundingClientRect()
    anchor.relocated ||= Math.abs(bounds.left - anchor.left) > .5 || Math.abs(bounds.top - anchor.top) > .5
    if (!anchor.relocated) return
    // Blink retains a screen-coordinate drag origin. A moving pane can put that
    // origin in the other pane, even though the original text node is retained.
    // After relocation, extend from the saved DOM caret instead of that origin.
    const caret = document.caretRangeFromPoint(event.clientX, event.clientY)
    if (caret && this.root.contains(caret.startContainer) && caret.startContainer.parentElement?.closest('.textLayer')) {
      window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, caret.startContainer, caret.startOffset)
    }
  }
  private mouseDown = (event: MouseEvent) => {
    // Native word/paragraph drags already have a non-collapsed DOM anchor.
    // Keep their selection granularity; only a single-click caret needs repair.
    if (event.detail > 1) this.dragAnchor = null
  }
  private pointerEnd = () => { this.dragAnchor = null; this.dragging = null; this.selection() }
  destroy() {
    clearTimeout(this.timer); this.near.disconnect(); this.viewport.disconnect(); this.pages.clear()
    document.removeEventListener('selectionchange', this.selection)
    this.root.removeEventListener('pointerdown', this.pointerDown)
    this.root.removeEventListener('mousedown', this.mouseDown)
    document.removeEventListener('pointerup', this.pointerEnd)
    document.removeEventListener('pointercancel', this.pointerEnd)
    document.removeEventListener('mousemove', this.mouseMove, true)
  }
}
