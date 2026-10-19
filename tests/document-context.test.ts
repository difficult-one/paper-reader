import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DocumentContext, extractPdfParagraphs, retrieveEvidence, validateQuestionSelection } from '../src/main/document-context'
import type { DocumentParagraph, SelectionSnapshot } from '../src/shared/types'
import { inspectPdf } from '../src/main/engine'

const hash = 'a'.repeat(64)
const anchor = (page = 1) => ({ page, rects: [{ x: .08, y: .1, width: .4, height: .04 }] })
const selection: SelectionSnapshot = { quote: 'ABC', anchors: [anchor()] }
const paragraph = (page: number, text: string, y = .1): DocumentParagraph => ({ documentHash: hash, sourceVersion: 'original', page, paragraphId: `p${page}-${y}`, text, rects: [{ x: .08, y, width: .4, height: .04 }] })

describe('question selection', () => {
  it('keeps an immutable snapshot tied to physical page bounds', () => {
    const draft = structuredClone(selection)
    const frozen = validateQuestionSelection(draft, 2)
    draft.anchors[0].page = 2
    expect(frozen.anchors[0].page).toBe(1)
    expect(() => validateQuestionSelection({ ...selection, anchors: [anchor(3)] }, 2)).toThrow(/页码/)
    expect(() => validateQuestionSelection({ ...selection, anchors: [{ ...anchor(), rects: [{ x: NaN, y: 0, width: 1, height: 1 }] }] }, 2)).toThrow(/坐标/)
  })
  it('rejects long selections without truncation and arbitrary anchor payloads', () => {
    expect(() => validateQuestionSelection({ ...selection, quote: 'x'.repeat(2001) }, 2)).toThrow(/2,000|2000/)
    expect(() => validateQuestionSelection({ ...selection, anchors: [] }, 2)).toThrow(/选区/)
  })
})

describe('local evidence', () => {
  it('bounds concurrent background indexing when many papers are opened together', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'question-index-'))
    let active = 0; let peak = 0
    const context = new DocumentContext(directory, async () => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 15)); active--; return []
    })
    try {
      await Promise.all(Array.from({ length: 8 }, (_, i) => context.get({ documentId: hash, documentHash: i.toString(16).repeat(64), sourceVersion: 'original', pages: 1, path: 'internal' })))
      expect(peak).toBeLessThanOrEqual(2)
    } finally { await context.shutdown(); await rm(directory, { recursive: true, force: true }) }
  })
  it('extracts Chinese CID text using packaged CMaps', async () => {
    const pdf = await PDFDocument.create(); const page = pdf.addPage([600, 800])
    const cid = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'STSong-Light', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 4 } }))
    const font = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light', Encoding: 'UniGB-UCS2-H', DescendantFonts: [cid] }))
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { F1: font } }))
    page.node.addContentStream(pdf.context.register(pdf.context.flateStream('BT /F1 16 Tf 40 700 Td <4E2D6587> Tj ET')))
    const paragraphs = await extractPdfParagraphs(new Uint8Array(await pdf.save()), hash, 'original')
    expect(paragraphs.map(p => p.text).join('')).toBe('中文')
    const directory = await mkdtemp(join(tmpdir(), 'question-cid-'))
    try { const path = join(directory, '中文.pdf'); await writeFile(path, await pdf.save()); expect((await inspectPdf(path)).hasText).toBe(true) }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('uses the worker entry resolved by its caller even when this module is shared in another directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reader-context-worker-'))
    const worker = join(directory, 'entry-worker.mjs')
    await writeFile(worker, `import { parentPort, workerData } from 'node:worker_threads'; parentPort.postMessage({ paragraphs: [{ text: 'Indexed by the configured entry', documentHash: workerData.documentHash, sourceVersion: workerData.sourceVersion, page: 1, paragraphId: 'p1', rects: [] }] })`)
    const context = new DocumentContext(directory, { workerUrl: pathToFileURL(worker) })
    try {
      const result = await context.get({ documentId: hash, documentHash: hash, sourceVersion: 'original', path: 'unused', pages: 1 })
      expect(result[0].text).toBe('Indexed by the configured entry')
    } finally { await context.shutdown(); await rm(directory, { recursive: true, force: true }) }
  })
  it('retrieves a definition on another page and retains authoritative anchors', () => {
    const paragraphs = [paragraph(1, 'ABC improves the result.'), paragraph(2, 'ABC (adaptive boundary correction) is defined as a local correction.'), paragraph(3, 'Unrelated results.')]
    const evidence = retrieveEvidence(paragraphs, selection, '解释术语')
    expect(evidence.some(s => s.page === 2 && s.text.includes('adaptive'))).toBe(true)
    expect(evidence[0]).toMatchObject({ id: 'S1', page: 1, sourceVersion: 'original', documentHash: hash })
    expect(new Set(evidence.map(s => s.id)).size).toBe(evidence.length)
  })
  it('does not silently cut a paragraph to fit the budget or cite nonexistent text', () => {
    expect(() => retrieveEvidence([paragraph(1, 'ABC ' + 'long '.repeat(6000))], selection, 'ABC', 200)).toThrow(/预算|缩小/)
    expect(retrieveEvidence([], selection, 'ABC')).toEqual([])
  })
  it('rejects selected context overflow instead of silently omitting selected paragraphs', () => {
    const paragraphs = [paragraph(1, '中文'.repeat(800)), paragraph(1, '论文'.repeat(800), .14)]
    expect(() => retrieveEvidence(paragraphs, { quote: '文中', anchors: [{ page: 1, rects: [{ x: .08, y: .12, width: .4, height: .05 }] }] }, '解释')).toThrow(/预算|缩小/)
    expect(retrieveEvidence([paragraph(2, 'ABC is defined here')], selection, 'ABC')).toEqual([])
  })
  it('extracts real PDF geometry and column order instead of content-stream order', async () => {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([600, 800])
    page.drawText('A full width title for a two column scientific research paper', { x: 40, y: 750, font, size: 15 })
    for (let row = 0; row < 4; row++) {
      page.drawText(`Left column sentence ${row}.`, { x: 40, y: 700 - row * 18, font, size: 11 })
      page.drawText(`Right column sentence ${row}.`, { x: 320, y: 700 - row * 18, font, size: 11 })
    }
    const paragraphs = await extractPdfParagraphs(new Uint8Array(await pdf.save()), hash, 'original')
    const text = paragraphs.map(p => p.text).join('\n')
    expect(text.indexOf('Left column sentence 3')).toBeLessThan(text.indexOf('Right column sentence 0'))
    expect(paragraphs.every(p => p.page === 1 && p.rects.every(r => r.x >= 0 && r.y >= 0 && r.x + r.width <= 1.0001 && r.y + r.height <= 1.0001))).toBe(true)
  })
  it('leaves scanned pages without fabricated evidence', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage()
    expect(await extractPdfParagraphs(new Uint8Array(await pdf.save()), hash, 'original')).toEqual([])
  })
})
