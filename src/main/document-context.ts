import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { DocumentParagraph, HighlightRect, QuestionEvidence, SelectionSnapshot } from '../shared/types'
import { readJson, writeJson } from './store'

export interface QuestionDocumentSource { documentId: string; documentHash: string; sourceVersion: string; path: string; pages: number }
const INDEX_VERSION = 2
export function validateQuestionSelection(value: SelectionSnapshot, pages: number): SelectionSnapshot {
  if (!value || typeof value.quote !== 'string' || !value.quote.trim()) throw new Error('请先选中论文中的文字。')
  if (value.quote.length > 2000) throw new Error('选区超过 2,000 字符，请缩小范围或分段提问。')
  if (!Array.isArray(value.anchors) || !value.anchors.length || value.anchors.length > 20) throw new Error('选区位置无效。')
  const anchors = value.anchors.map(anchor => {
    if (!anchor || !Number.isInteger(anchor.page) || anchor.page < 1 || anchor.page > pages) throw new Error('选区页码无效。')
    if (!Array.isArray(anchor.rects) || !anchor.rects.length || anchor.rects.length > 500) throw new Error('选区坐标无效。')
    return { page: anchor.page, rects: anchor.rects.map(rect => {
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.00001 || rect.y + rect.height > 1.00001) throw new Error('选区坐标超出页面。')
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }) }
  })
  return { quote: value.quote.trim(), anchors }
}
interface Fragment { text: string; x: number; y: number; width: number; height: number }
function readingOrder(fragments: Fragment[], width: number): Fragment[] {
  const rows: Fragment[][] = []
  for (const fragment of [...fragments].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = rows.find(r => Math.abs(r[0].y - fragment.y) < Math.min(r[0].height, fragment.height) * .45)
    if (!row) { row = []; rows.push(row) }
    row.push(fragment)
  }
  const segments: Fragment[] = []; const cuts: number[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    let current: Fragment | undefined
    for (const item of row) {
      const gap = current ? item.x - current.x - current.width : 0
      if (current && gap < width * .065) {
        current.text += `${gap > item.height * .15 ? ' ' : ''}${item.text}`; current.width = Math.max(current.width, item.x + item.width - current.x); current.height = Math.max(current.height, item.height)
      } else {
        if (current) { const cut = current.x + current.width + gap / 2; if (cut > width * .3 && cut < width * .7) cuts.push(cut) }
        current = { ...item }; segments.push(current)
      }
    }
  }
  if (cuts.length < 2) return segments.sort((a, b) => a.y - b.y || a.x - b.x)
  const cut = cuts.sort((a, b) => a - b)[Math.floor(cuts.length / 2)]
  const spanning = segments.filter(s => s.x < cut && s.x + s.width > cut)
  const ordered: Fragment[] = []; let band: Fragment[] = []
  const flush = () => { ordered.push(...band.filter(s => s.x < cut).sort((a, b) => a.y - b.y), ...band.filter(s => s.x >= cut).sort((a, b) => a.y - b.y)); band = [] }
  for (const segment of segments.sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (spanning.includes(segment)) { flush(); ordered.push(segment) } else band.push(segment)
  }
  flush(); return ordered
}
export async function extractPdfParagraphs(bytes: Uint8Array, documentHash: string, sourceVersion: string): Promise<DocumentParagraph[]> {
  const { getDocument, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const assets = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))
  const loading = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0, cMapUrl: join(assets, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(assets, 'standard_fonts') + '/' })
  try {
    const pdf = await loading.promise; const paragraphs: DocumentParagraph[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number); const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent(); const fragments: Fragment[] = []
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue
        const transform = Util.transform(viewport.transform, item.transform)
        const height = Math.max(1, Math.hypot(transform[2], transform[3]))
        const x = Math.max(0, Math.min(viewport.width, transform[4])); const y = Math.max(0, Math.min(viewport.height, transform[5] - height))
        fragments.push({ text: item.str, x, y, width: Math.max(0, Math.min(item.width, viewport.width - x)), height: Math.min(height * 1.2, viewport.height - y) })
      }
      const lines = readingOrder(fragments, viewport.width)
      let paragraph: DocumentParagraph | undefined; let previous: Fragment | undefined
      for (const line of lines) {
        const rect: HighlightRect = { x: line.x / viewport.width, y: line.y / viewport.height, width: line.width / viewport.width, height: line.height / viewport.height }
        if (rect.width <= 0 || rect.height <= 0) continue
        const join = previous && paragraph && Math.abs(line.x - previous.x) < viewport.width * .07 && line.y > previous.y && line.y - previous.y < Math.max(line.height, previous.height) * 1.9 && paragraph.text.length + line.text.length < 1800
        if (join) { paragraph!.text += ` ${line.text}`; paragraph!.rects.push(rect) }
        else {
          paragraph = { documentHash, sourceVersion, page: number, paragraphId: `p${number}-${paragraphs.length + 1}`, text: line.text, rects: [rect] }
          paragraphs.push(paragraph)
        }
        previous = line
      }
      page.cleanup()
      // The production caller runs this loop off the main/renderer threads.
    }
    return paragraphs
  } finally { await loading.destroy() }
}
function terms(text: string): string[] {
  const normalized = text.toLowerCase().normalize('NFKC')
  const words: string[] = normalized.match(/[a-z0-9][a-z0-9-]+/g) ?? []
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) { if (run.length === 1) words.push(run); else for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2)) }
  return [...new Set(words.filter(w => !['the', 'and', 'for', 'this', 'that', 'with', 'from', 'what', 'how'].includes(w)))]
}
const intersects = (a: HighlightRect, b: HighlightRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
export function retrieveEvidence(paragraphs: DocumentParagraph[], selection: SelectionSnapshot, question: string, byteBudget = 8000): QuestionEvidence[] {
  const selected = paragraphs.map((p, i) => selection.anchors.some(a => a.page === p.page && a.rects.some(r => p.rects.some(pr => intersects(r, pr)))) ? i : -1).filter(i => i >= 0)
  if (!selected.length) return []
  // Selected context is mandatory. Only optional neighbors/search hits may be omitted.
  if (selected.length > 16 || selected.reduce((size, index) => size + Buffer.byteLength(paragraphs[index].text, 'utf8') + 200, 0) > byteBudget) throw new Error('选区对应的正文超出上下文预算，请缩小范围或分段提问。')
  const candidates = new Set<number>()
  for (const index of selected) candidates.add(index)
  for (const index of selected) for (const neighbor of [index - 1, index + 1]) if (paragraphs[neighbor]) candidates.add(neighbor)
  const query = terms(`${selection.quote} ${question}`)
  const termSets = paragraphs.map(p => new Set(terms(p.text)))
  const frequencies = new Map<string, number>()
  for (const set of termSets) for (const term of set) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
  const ranked = paragraphs.map((p, index) => ({ index, score: query.reduce((score, word) => score + (termSets[index].has(word) ? Math.log(1 + paragraphs.length / (frequencies.get(word) || 1)) : 0), 0) * (/\b(?:defined|means|stands for|called|is a)\b|定义|称为|是指|简称/i.test(p.text) ? 1.3 : 1) }))
    .filter(p => p.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
  for (const match of ranked) candidates.add(match.index)
  const evidence: QuestionEvidence[] = []; let used = 0
  for (const index of candidates) {
    const p = paragraphs[index]; const size = Buffer.byteLength(p.text, 'utf8') + 200
    if (used + size > byteBudget) continue
    used += size; evidence.push({ ...p, id: `S${evidence.length + 1}` })
    if (evidence.length >= 16) break
  }
  return evidence
}

export class DocumentContext {
  private pending = new Map<string, Promise<DocumentParagraph[]>>()
  private workers = new Set<Worker>()
  private resident = new Set<string>()
  private jobs: { interactive: boolean; run(): void; reject(error: unknown): void }[] = []
  private running = 0
  private closed = false
  constructor(private directory: string, private extractor: ((source: QuestionDocumentSource) => Promise<DocumentParagraph[]>) | { workerUrl: URL }) {}
  private schedule<T>(action: () => Promise<T>, signal?: AbortSignal, interactive = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error('论文索引已关闭。'))
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => { this.jobs = this.jobs.filter(item => item !== job); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
      const job = { interactive, reject: (error: unknown) => { signal?.removeEventListener('abort', abort); reject(error) }, run: () => {
        signal?.removeEventListener('abort', abort); this.running++
        void action().then(resolve, reject).finally(() => { this.running--; this.pump() })
      } }
      signal?.addEventListener('abort', abort, { once: true }); this.jobs.push(job); this.pump()
    })
  }
  private pump() {
    while (!this.closed && this.running < 2 && this.jobs.length) {
      const interactive = this.jobs.findIndex(job => job.interactive)
      this.jobs.splice(interactive < 0 ? 0 : interactive, 1)[0].run()
    }
  }
  private worker<T>(data: unknown, field: 'paragraphs' | 'evidence', signal?: AbortSignal): Promise<T> {
    if (typeof this.extractor === 'function') throw new Error('未配置索引工作线程。')
    const { workerUrl } = this.extractor
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const worker = new Worker(workerUrl, { workerData: data })
      this.workers.add(worker)
      let received = false; let result: T; let failure: Error | undefined
      const abort = () => { void worker.terminate(); reject(signal?.reason) }
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('message', message => { received = true; if (message.error) failure = new Error(message.error); else result = message[field] })
      worker.once('error', reject)
      worker.once('exit', code => {
        signal?.removeEventListener('abort', abort); this.workers.delete(worker)
        if (failure) reject(failure)
        else if (code !== 0 || !received) reject(new Error('论文文本索引中断，请重新打开论文。'))
        else resolve(result!)
      })
    })
  }
  private extract(source: QuestionDocumentSource): Promise<DocumentParagraph[]> {
    return this.schedule(() => typeof this.extractor === 'function' ? this.extractor(source) : this.worker({ ...source, operation: 'extract' }, 'paragraphs'))
  }
  async evidence(source: QuestionDocumentSource, selection: SelectionSnapshot, question: string, signal: AbortSignal): Promise<QuestionEvidence[]> {
    const paragraphs = await this.get(source, signal)
    return this.schedule(() => typeof this.extractor === 'function' ? Promise.resolve(retrieveEvidence(paragraphs, selection, question)) : this.worker({ operation: 'retrieve', paragraphs, selection, question }, 'evidence', signal), signal, true)
  }
  async get(source: QuestionDocumentSource, signal?: AbortSignal): Promise<DocumentParagraph[]> {
    const key = `${source.documentHash}-${source.sourceVersion}`
    if (this.closed) throw new Error('论文索引已关闭。')
    if (this.resident.delete(key)) this.resident.add(key)
    let pending = this.pending.get(key)
    if (!pending) {
      pending = (async () => {
        const path = join(this.directory, 'question-index', `${source.documentHash}.json`)
        const cached = await readJson<{ version: number; paragraphs: DocumentParagraph[] } | null>(path, null).catch(() => null)
        const paragraphs = cached?.version === INDEX_VERSION && Array.isArray(cached.paragraphs) ? cached.paragraphs : await this.extract(source)
        if (!cached || cached.version !== INDEX_VERSION) await writeJson(path, { version: INDEX_VERSION, paragraphs }).catch(() => {})
        return paragraphs.map(p => ({ ...p, sourceVersion: source.sourceVersion, documentHash: source.documentHash }))
      })()
      this.pending.set(key, pending)
      void pending.then(() => {
        if (this.closed) return
        this.resident.add(key)
        while (this.resident.size > 4) { const oldest = this.resident.values().next().value!; this.resident.delete(oldest); this.pending.delete(oldest) }
      }, () => { if (this.pending.get(key) === pending) this.pending.delete(key) })
    }
    if (!signal) return pending
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      void pending!.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
      if (signal.aborted) abort()
    })
  }
  async shutdown() {
    this.closed = true
    for (const job of this.jobs.splice(0)) job.reject(new Error('论文索引已关闭。'))
    await Promise.allSettled([...this.workers].map(w => w.terminate())); this.pending.clear(); this.resident.clear()
  }
}
