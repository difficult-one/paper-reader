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
    expect(visibility.isPinned(second as Element)).toBe(false)
    document.dispatchEvent(new Event('pointerup'))
    expect(visibility.isPinned(first as Element)).toBe(false)
    expect(visibility.isDragging(first as Element)).toBe(false)
    range = { intersectsNode: element => element === first || element === second }
    expect(visibility.isPinned(first as Element)).toBe(true)
    document.dispatchEvent(new Event('selectionchange'))
    expect(visibility.isPinned(first as Element)).toBe(true)
    expect(visibility.isPinned(second as Element)).toBe(true)
    visibility.destroy()
  } finally { vi.unstubAllGlobals() }
})
