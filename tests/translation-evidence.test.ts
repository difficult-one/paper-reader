import { expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractTranslationSource, locateTranslationSource, inspectTranslationLayout, renderLayoutThumbnails } from '../src/main/translation-evidence'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function pdf(lines: { text: string; page?: number; x?: number }[]) {
  const document = await PDFDocument.create(); const font = await document.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i <= Math.max(...lines.map(line => line.page ?? 0)); i++) document.addPage([600, 800])
  lines.forEach((line, i) => document.getPage(line.page ?? 0).drawText(line.text, { font, size: 12, x: line.x ?? 30, y: 730 - i * 20 }))
  return new Uint8Array(await document.save())
}
it('anchors only real unique source text and retains document/extraction provenance', async () => {
  const index = await extractTranslationSource(await pdf([{ text: 'ABC is defined as adaptive boundary correction.' }, { text: 'Results may differ.', page: 1 }]), 'paper')
  const result = locateTranslationSource(index, 'ABC is defined as adaptive boundary correction.')
  expect(result?.page).toBe(1)
  expect(result?.rects[0].x).toBeCloseTo(.05)
  expect(index.documentId).toBe('paper')
  expect(index.sourceVersion).toContain(index.extractionVersion)
  expect(locateTranslationSource(index, 'An invented definition.')).toBeNull()
  expect(locateTranslationSource(index, 'Results may differ.')?.page).toBe(2)
})
it('does not fabricate a page for repeated text or scanned pages', async () => {
  const index = await extractTranslationSource(await pdf([{ text: 'Repeated sentence.' }, { text: 'Repeated sentence.', page: 1 }]), 'paper')
  expect(locateTranslationSource(index, 'Repeated sentence.')).toBeNull()
  const document = await PDFDocument.create(); document.addPage()
  const scanned = await extractTranslationSource(new Uint8Array(await document.save()), 'scan')
  expect(scanned.pages[0].spans).toEqual([])
  expect(scanned.issues.some(issue => issue.page === 1 && issue.category === 'extraction')).toBe(true)
})
it('does not anchor source text with changed variable case or a missing minus sign', async () => {
  const index = await extractTranslationSource(await pdf([{ text: 'The variable K equals -10.' }]), 'paper')
  expect(locateTranslationSource(index, 'The variable k equals -10.')).toBeNull()
  expect(locateTranslationSource(index, 'The variable K equals 10.')).toBeNull()
  expect(locateTranslationSource(index, 'The variable K equals −10.')?.page).toBe(1)
})
it('anchors a multi-line paragraph without losing sentence punctuation between PDF spans', async () => {
  const index = await extractTranslationSource(await pdf([{ text: '1. Example author. The method may improve stability.' }, { text: 'This continuation belongs to the same entry.' }]), 'paper')
  const location = locateTranslationSource(index, '1. Example author. The method may improve stability. This continuation belongs to the same entry.')
  expect(location?.page).toBe(1)
  expect(location?.rects).toHaveLength(2)
})
it('matches a CrossRef marker when the engine turns its brackets into formula placeholders', async () => {
  const index = await extractTranslationSource(await pdf([{ text: '1. Example author. A reference. [CrossRef]' }]), 'paper')
  expect(locateTranslationSource(index, '1. Example author. A reference. {v1}CrossRef{v2}')?.page).toBe(1)
  expect(locateTranslationSource(index, '2. Example author. A reference. {v1}CrossRef{v2}')).toBeNull()
})
it('checks generated PDF geometry independently without claiming a visual review', async () => {
  const result = await inspectTranslationLayout(await pdf([{ text: 'Overflow text outside the page.', x: 590 }]), 1)
  expect(result.status).toBe('unresolved')
  expect(result.issues.some(issue => issue.page === 1 && issue.category === 'layout')).toBe(true)
  expect(result.visualReview).toBe('pending')
  expect((await inspectTranslationLayout(await pdf([{ text: 'Within page.' }]), 2)).issues.some(issue => issue.issue.includes('页数'))).toBe(true)
})
it('renders thumbnails for flagged pages with real page locations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'layout-thumbnail-'))
  try {
    const thumbnails = await renderLayoutThumbnails(await pdf([{ text: 'Review this page.' }]), [1], directory)
    expect(thumbnails[0]).toMatchObject({ page: 1, status: 'rendered' })
    expect((await readFile(thumbnails[0].path!)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
