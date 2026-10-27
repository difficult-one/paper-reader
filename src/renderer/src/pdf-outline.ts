import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Position } from '../../shared/types'

export interface PdfOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineNode[];
}

export async function outlinePosition(pdf: PDFDocumentProxy, target: PdfOutlineNode['dest']): Promise<Position | null> {
  const destination = typeof target === 'string' ? await pdf.getDestination(target) : target
  if (!Array.isArray(destination) || !destination.length) return null
  const reference = destination[0]
  let index: number
  if (typeof reference === 'number') index = reference
  else if (reference && typeof reference === 'object' && 'num' in reference && 'gen' in reference && typeof reference.num === 'number' && typeof reference.gen === 'number') index = await pdf.getPageIndex({ num: reference.num, gen: reference.gen })
  else return null
  if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) return null
  const kind = destination[1] && typeof destination[1] === 'object' && 'name' in destination[1] ? destination[1].name : undefined
  if (typeof kind !== 'string' || !['XYZ', 'FitH', 'FitBH', 'FitV', 'FitBV', 'FitR'].includes(kind)) return { page: index + 1, fraction: 0 }
  const page = await pdf.getPage(index + 1)
  const viewport = page.getViewport({ scale: 1 })
  const coordinate = (at: number, fallback: number) => typeof destination[at] === 'number' && Number.isFinite(destination[at]) ? destination[at] as number : fallback
  let points: [number, number][]
  if (kind === 'XYZ') points = [[coordinate(2, page.view[0]), coordinate(3, page.view[3])]]
  else if (kind === 'FitR') points = [[coordinate(2, page.view[0]), coordinate(3, page.view[1])], [coordinate(4, page.view[2]), coordinate(5, page.view[3])]]
  else if (kind === 'FitV' || kind === 'FitBV') points = [[coordinate(2, page.view[0]), page.view[1]], [coordinate(2, page.view[0]), page.view[3]]]
  else points = [[page.view[0], coordinate(2, page.view[3])], [page.view[2], coordinate(2, page.view[3])]]
  const y = Math.min(...points.map(([x, y]) => viewport.convertToViewportPoint(x, y)[1]))
  return { page: index + 1, fraction: Math.max(0, Math.min(.999, y / viewport.height)) }
}
