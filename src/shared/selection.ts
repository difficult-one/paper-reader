import type { HighlightRect } from './types'
export interface ClientBox { left: number; top: number; width: number; height: number }
export function normalizeSelectionRects(page: ClientBox, rects: ClientBox[], rotation = 0): HighlightRect[] {
  if (page.width <= 0 || page.height <= 0) return []
  const boxes: ClientBox[] = []
  for (const rect of rects) {
    const left = Math.max(page.left, rect.left); const top = Math.max(page.top, rect.top)
    const right = Math.min(page.left + page.width, rect.left + rect.width); const bottom = Math.min(page.top + page.height, rect.top + rect.height)
    if (right - left < 1 || bottom - top < 1) continue
    boxes.push({ left, top, width: right - left, height: bottom - top })
  }
  const vertical = rotation % 180 !== 0
  const along = vertical ? 'top' : 'left'; const across = vertical ? 'left' : 'top'
  const length = vertical ? 'height' : 'width'; const thickness = vertical ? 'width' : 'height'
  const lines: ClientBox[] = []
  // Work in screen pixels: a word space scales with text height, not page width.
  for (const box of boxes.sort((a, b) => a[along] - b[along] || a[across] - b[across])) {
    const line = lines.find(candidate => {
      const overlap = Math.min(candidate[across] + candidate[thickness], box[across] + box[thickness]) - Math.max(candidate[across], box[across])
      const gap = box[along] - (candidate[along] + candidate[length])
      const smaller = Math.min(candidate[thickness], box[thickness])
      const larger = Math.max(candidate[thickness], box[thickness])
      const centerOffset = Math.abs(candidate[across] + candidate[thickness] / 2 - box[across] - box[thickness] / 2)
      return smaller >= larger * .5 && centerOffset <= smaller * .4 && overlap >= smaller * .5 && gap <= smaller * .8
    })
    if (!line) { lines.push({ ...box }); continue }
    const right = Math.max(line.left + line.width, box.left + box.width)
    const bottom = Math.max(line.top + line.height, box.top + box.height)
    line.left = Math.min(line.left, box.left); line.top = Math.min(line.top, box.top)
    line.width = right - line.left; line.height = bottom - line.top
  }
  return lines.map(box => ({ x: (box.left - page.left) / page.width, y: (box.top - page.top) / page.height, width: box.width / page.width, height: box.height / page.height }))
}
export const highlightColors = { yellow: '#f5d85e', green: '#91d5a1', blue: '#8cc9ef', pink: '#efb0c6' }
export const colorNames = { yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色' }
