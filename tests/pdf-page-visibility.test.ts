import { expect, it, vi } from 'vitest'
import { PdfPageVisibility } from '../src/renderer/src/pdf-page-visibility'

it('折叠选区的拖选起点从 pointerdown 固定，松开后释放，活动跨页选区仍固定', () => {
  const root = new EventTarget()
  const document = new EventTarget()
  const first = {}; const second = {}
  let range: { intersectsNode(element: unknown): boolean } | null = null
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', { getSelection: () => ({ isCollapsed: !range, rangeCount: range ? 1 : 0, getRangeAt: () => range }) })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  try {
    const visibility = new PdfPageVisibility(root as HTMLElement)
    visibility.observe(first as Element, () => {}); visibility.observe(second as Element, () => {})
    const event = new Event('pointerdown')
    Object.defineProperty(event, 'target', { value: { closest: (selector: string) => selector === '.textLayer' ? { getBoundingClientRect: () => ({ left: 12, top: 34 }) } : first } })
    root.dispatchEvent(event)
    expect(visibility.isPinned(first as Element)).toBe(true)
    expect(visibility.isDragging(first as Element)).toBe(true)
    expect(visibility.isDragging()).toBe(true)
    expect(visibility.isPinned(second as Element)).toBe(false)
    document.dispatchEvent(new Event('pointerup'))
    expect(visibility.isPinned(first as Element)).toBe(false)
    expect(visibility.isDragging(first as Element)).toBe(false)
    expect(visibility.isDragging()).toBe(false)
    range = { intersectsNode: element => element === first || element === second }
    expect(visibility.isPinned(first as Element)).toBe(true)
    document.dispatchEvent(new Event('selectionchange'))
    expect(visibility.isPinned(first as Element)).toBe(true)
    expect(visibility.isPinned(second as Element)).toBe(true)
    visibility.destroy()
  } finally { vi.unstubAllGlobals() }
})

it.each(['resize', 'zoom settlement'])('repairs a drag anchor after %s without moving the pane origin', change => {
  const root = new EventTarget(); const document = new EventTarget(); const page = {}
  const anchor = { isConnected: true }; const end = { parentElement: { closest: () => layer } }
  let width = 200; let textWidth = 100; let extending = false
  const layer = { contains: (node: unknown) => node === anchor, getBoundingClientRect: () => ({ left: 30, top: 40, width: textWidth, height: 100 }) }
  const extensions: unknown[][] = []
  Object.assign(root, { contains: () => true, getBoundingClientRect: () => ({ left: 10, top: 20, width, height: 500 }) })
  Object.assign(document, { caretRangeFromPoint: () => ({ startContainer: extending ? end : anchor, startOffset: extending ? 5 : 1 }) })
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', { getSelection: () => ({ isCollapsed: true, rangeCount: 0, setBaseAndExtent: (...args: unknown[]) => extensions.push(args) }) })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const visibility = new PdfPageVisibility(root as HTMLElement)
  try {
    visibility.observe(page as Element, () => {})
    const down = new Event('pointerdown')
    Object.defineProperties(down, { target: { value: { closest: (selector: string) => selector === '.textLayer' ? layer : page } }, button: { value: 0 }, clientX: { value: 30 }, clientY: { value: 40 } })
    root.dispatchEvent(down)
    if (change === 'resize') width = 250
    textWidth = 125; extending = true
    const move = new Event('mousemove')
    Object.defineProperties(move, { buttons: { value: 1 }, clientX: { value: 120 }, clientY: { value: 40 } })
    document.dispatchEvent(move)
    expect(extensions).toEqual([[anchor, 1, end, 5]])
  } finally { visibility.destroy(); vi.unstubAllGlobals() }
})

it('rapid repeated drags select from the pointer caret rather than using paragraph granularity', () => {
  const root = new EventTarget(); const doc = new EventTarget(); const page = {}
  const anchor = { isConnected: true }; const end = { parentElement: { closest: () => layer } }
  const layer = { contains: (node: unknown) => node === anchor, getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) }
  let moving = false; const extensions: unknown[][] = []
  Object.assign(root, { contains: () => true })
  Object.assign(doc, { caretRangeFromPoint: () => ({ startContainer: moving ? end : anchor, startOffset: moving ? 7 : 2 }) })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', { getSelection: () => ({ isCollapsed: true, rangeCount: 0, setBaseAndExtent: (...args: unknown[]) => extensions.push(args) }) })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const visibility = new PdfPageVisibility(root as HTMLElement)
  try {
    visibility.observe(page as Element, () => {})
    const down = new Event('pointerdown')
    Object.defineProperties(down, { target: { value: { closest: (selector: string) => selector === '.textLayer' ? layer : page } }, button: { value: 0 }, clientX: { value: 10 }, clientY: { value: 10 } })
    root.dispatchEvent(down)
    const mouseDown = new Event('mousedown')
    Object.defineProperty(mouseDown, 'detail', { value: 3 }); root.dispatchEvent(mouseDown)
    moving = true
    const move = new Event('mousemove', { cancelable: true })
    Object.defineProperties(move, { buttons: { value: 1 }, clientX: { value: 80 }, clientY: { value: 10 } })
    doc.dispatchEvent(move)
    expect(extensions).toEqual([[anchor, 2, end, 7]])
    expect(move.defaultPrevented).toBe(true)
  } finally { visibility.destroy(); vi.unstubAllGlobals() }
})
