import { createHash } from 'node:crypto'
import type { HighlightRect } from '../shared/types'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export const TRANSLATION_SOURCE_VERSION = 'pdfjs-source-locations-v4'
export interface SourceLocation { paragraphId: string; page: number | null; section: string; rects: HighlightRect[] }
export interface SourceProblem { page: number | null; category: 'extraction' | 'layout'; issue: string }
export interface TranslationSourceIndex {
  documentId: string; sourceVersion: string; extractionVersion: string;
  pages: { page: number; width: number; height: number; spans: { text: string; rect: HighlightRect; outside: boolean }[] }[];
  issues: SourceProblem[];
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalized = (text: string) => text.normalize('NFKC').replace(/<\/?[A-Za-z][^>]*>|\{\w+\}|[\s\u00ad]/g, '').replace(/\[(CrossRef|PubMed|PMC)\]/g, '$1').replace(/[−﹣－]/g, '-')

export async function extractTranslationSource(bytes: Uint8Array, documentId: string): Promise<TranslationSourceIndex> {
  const { getDocument, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 })
  const result: TranslationSourceIndex = { documentId, sourceVersion: `${documentId}:${TRANSLATION_SOURCE_VERSION}`, extractionVersion: TRANSLATION_SOURCE_VERSION, pages: [], issues: [] }
  try {
    const doc = await loading.promise
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number); const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const spans = content.items.flatMap(item => {
        if (!('str' in item) || !item.str.trim()) return []
        const transform = Util.transform(viewport.transform, item.transform)
        const h = Math.hypot(transform[2], transform[3])
        const x = transform[4] / viewport.width; const y = (transform[5] - h) / viewport.height
        const width = item.width / viewport.width; const height = h / viewport.height
        return [{ text: item.str, rect: { x, y, width, height }, outside: x < -.005 || y < -.005 || x + width > 1.005 || y + height > 1.005 }]
      })
      // Only order clearly separated narrow columns. Spanning headings stay in their vertical band.
      const left = spans.filter(span => span.rect.x < .45 && span.rect.width < .48)
      const right = spans.filter(span => span.rect.x > .48 && span.rect.width < .48)
      const twoColumns = left.length >= 3 && right.length >= 3
      spans.sort((a, b) => {
        if (twoColumns && a.rect.width < .48 && b.rect.width < .48 && (a.rect.x > .48) !== (b.rect.x > .48)) return a.rect.x - b.rect.x
        return Math.abs(a.rect.y - b.rect.y) > .005 ? a.rect.y - b.rect.y : a.rect.x - b.rect.x
      })
      result.pages.push({ page: number, width: viewport.width, height: viewport.height, spans })
      if (!spans.length) result.issues.push({ page: number, category: 'extraction', issue: '此页无可提取文字；扫描件、公式和图片文字需人工核对。' })
      page.cleanup()
    }
    return result
  } finally { await loading.destroy() }
}

export function locateTranslationSource(index: TranslationSourceIndex, quote: string): SourceLocation | null {
  const needle = normalized(quote)
  if (needle.length < 8) return null
  const found: SourceLocation[] = []
  for (const page of index.pages) {
    const strings = page.spans.map(span => normalized(span.text))
    const text = strings.join(''); let start = text.indexOf(needle)
    while (start >= 0) {
      let offset = 0
      const rects = page.spans.filter((_span, i) => { const previous = offset; offset += strings[i].length; return offset > start && previous < start + needle.length }).map(span => span.rect)
      found.push({ paragraphId: hash([index.sourceVersion, page.page, start, needle]), page: page.page, section: 'document', rects })
      start = text.indexOf(needle, start + 1)
    }
  }
  // Ambiguous or altered extraction stays unlocated instead of receiving a guessed page.
  return found.length === 1 ? found[0] : null
}

export async function inspectTranslationLayout(bytes: Uint8Array, expectedPages: number) {
  const index = await extractTranslationSource(bytes, 'generated')
  const issues: SourceProblem[] = [...index.issues]
  if (index.pages.length !== expectedPages) issues.push({ page: null, category: 'layout', issue: `译文页数 ${index.pages.length} 与原文页数 ${expectedPages} 不一致。` })
  for (const page of index.pages) if (page.spans.some(span => span.outside)) issues.push({ page: page.page, category: 'layout', issue: '存在超出页面边界的可提取文字，需视觉核对。' })
  return { status: issues.length ? 'unresolved' : 'structure-passed', visualReview: 'pending', checks: ['page-count', 'extractable-text', 'text-page-bounds'], issues }
}

export async function renderLayoutThumbnails(bytes: Uint8Array, pages: number[], directory: string): Promise<{ page: number; status: string; path?: string }[]> {
  const results: { page: number; status: string; path?: string }[] = []
  if (!pages.length) return results
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0 })
  try {
    // PDF.js ships this optional native canvas. Missing support leaves an explicit pending image.
    const { createCanvas } = createRequire(import.meta.url)('@napi-rs/canvas')
    const doc = await loading.promise
    await mkdir(directory, { recursive: true })
    for (const number of [...new Set(pages)].sort((a, b) => a - b)) {
      if (number < 1 || number > doc.numPages) continue
      try {
        const page = await doc.getPage(number); const size = page.getViewport({ scale: 1 }); const viewport = page.getViewport({ scale: 480 / size.width })
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise
        const path = join(directory, `page-${number}.png`)
        await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600 })
        results.push({ page: number, status: 'rendered', path }); page.cleanup()
      } catch { results.push({ page: number, status: 'unavailable' }) }
    }
  } catch { pages.forEach(page => results.push({ page, status: 'unavailable' })) }
  finally { await loading.destroy() }
  return results
}
