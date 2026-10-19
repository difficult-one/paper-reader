import type { HighlightRect } from './types'
export interface ClientBox { left: number; top: number; width: number; height: number }
export function normalizeSelectionRects(page: ClientBox, rects: ClientBox[]): HighlightRect[] {
  if (page.width <= 0 || page.height <= 0) return []
  const result: HighlightRect[] = []
  for (const rect of rects) {
    const left = Math.max(page.left, rect.left); const top = Math.max(page.top, rect.top)
    const right = Math.min(page.left + page.width, rect.left + rect.width); const bottom = Math.min(page.top + page.height, rect.top + rect.height)
    if (right - left < 1 || bottom - top < 1) continue
    const box = { x: (left - page.left) / page.width, y: (top - page.top) / page.height, width: (right - left) / page.width, height: (bottom - top) / page.height }
    if (!result.some(r => Math.abs(r.x - box.x) < .001 && Math.abs(r.y - box.y) < .001 && Math.abs(r.width - box.width) < .001 && Math.abs(r.height - box.height) < .001)) result.push(box)
  }
  return result
}
export const highlightColors = { yellow: '#f5d85e', green: '#91d5a1', blue: '#8cc9ef', pink: '#efb0c6' }
export const colorNames = { yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色' }
