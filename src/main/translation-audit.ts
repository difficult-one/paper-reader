import type { ChatRequest, Reply } from './translation-gateway'
import { describePrefix, fingerprint } from './cache-diagnostics'
import { parseBatch, validatedParagraphs } from './paragraph-cache'
import { locateTranslationSource, type TranslationSourceIndex } from './translation-evidence'
import { SEMANTIC_REVIEW_RULES, TranslationReview, type ReviewParagraph } from './translation-review'
import { TranslationGlossary } from './translation-glossary'

export interface TranslationQualityOptions { directory: string; sourceIndex?: TranslationSourceIndex; sampleRate?: number; cacheDirectory?: string; reviewer?: string }
export class TranslationAudit {
  readonly review: TranslationReview
  readonly glossary: TranslationGlossary
  private sourceVersion: string
  private extra: Record<string, unknown> = {}
  constructor(private options: TranslationQualityOptions & { documentId: string; policy: string }) {
    this.sourceVersion = options.sourceIndex?.sourceVersion ?? `${options.documentId}:unlocated`
    this.review = new TranslationReview({ directory: options.directory, documentId: options.documentId, sourceVersion: this.sourceVersion, translationPolicy: options.policy, sampleRate: options.sampleRate, cacheDirectory: options.cacheDirectory, reviewer: options.reviewer })
    this.glossary = new TranslationGlossary({ directory: options.directory, documentId: options.documentId, sourceVersion: this.sourceVersion })
  }
  private paragraph(source: string, output: string, context: string, occurrence = 0): ReviewParagraph {
    const location = this.options.sourceIndex && locateTranslationSource(this.options.sourceIndex, source)
    const titles = [...context.matchAll(/(?:The most recent title is:|First title in full text:|First title:)\s*([^\r\n]+)/g)]
    return { paragraphId: location?.paragraphId ?? fingerprint([this.sourceVersion, context, source, occurrence]), page: location?.page ?? null, rects: location?.rects ?? [], section: titles.at(-1)?.[1]?.trim() ?? 'document', source, output }
  }
  async observe(body: ChatRequest, reply: Reply, send: (body: ChatRequest) => Promise<string>) {
    const user = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
    const batch = parseBatch(body)
    const singleMarker = 'Now translate the following text:'
    const context = batch?.prefix ?? user.slice(0, Math.max(0, user.lastIndexOf(singleMarker)))
    let paragraphs: ReviewParagraph[] = []
    if (batch) {
      const outputs = reply.status >= 200 && reply.status < 300 ? validatedParagraphs(reply.body, batch.paragraphs) : reply.validatedOutputs ?? new Map()
      paragraphs = batch.paragraphs.map((item, index) => this.paragraph(item.input, outputs.get(item.id) ?? '', context, index))
    } else if (describePrefix(body).type === 'single') {
      const marker = 'Now translate the following text:'; const start = user.lastIndexOf(marker)
      const source = start < 0 ? user : user.slice(start + marker.length).trim()
      const content = reply.body.choices?.[0]?.message?.content
      paragraphs = [this.paragraph(source, reply.status >= 200 && reply.status < 300 && reply.body.choices?.[0]?.finish_reason === 'stop' && typeof content === 'string' ? content : '', start < 0 ? '' : user.slice(0, start))]
    } else if (describePrefix(body).type === 'terminology') {
      const marker = 'Input Text:\n```\n'; const start = user.lastIndexOf(marker); const end = user.lastIndexOf('\n```')
      if (start >= 0 && end > start && reply.status >= 200 && reply.status < 300 && reply.body.choices?.[0]?.finish_reason === 'stop') {
        try {
          const terms = JSON.parse(reply.body.choices[0].message!.content!.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
          const sources = user.slice(start + marker.length, end).split(/\n\s*\n/).map((source, index) => this.paragraph(source, '', user.slice(0, start).trim(), index))
          if (Array.isArray(terms)) this.glossary.add(terms, sources, 'extracted')
        } catch { /* Invalid terminology replies cannot create evidence. */ }
      }
    }
    // The upstream tables do not prove user authorship; keep that provenance distinct.
    const supplied = [...context.matchAll(/^\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*$/gm)]
      .map(match => ({ src: match[1].trim(), tgt: match[2].trim() }))
      .filter(term => !/^[-: ]+$/.test(term.src) && !/^Source Term$/i.test(term.src))
    this.glossary.add(supplied, paragraphs, 'supplied')
    paragraphs.forEach(paragraph => { paragraph.contextFingerprint = fingerprint([batch?.prefix ?? user.slice(0, Math.max(0, user.lastIndexOf('Now translate the following text:'))), batch?.sourceContext]) })
    if (paragraphs.length) await this.review.check(paragraphs, selected => send({ model: body.model, messages: [{ role: 'system', content: SEMANTIC_REVIEW_RULES }, { role: 'user', content: JSON.stringify({ context, sourceContext: batch?.sourceContext ?? [], paragraphs: selected }) }] }))
    await this.flush()
  }
  async flush(extra: Record<string, unknown> = {}) {
    Object.assign(this.extra, extra)
    await this.glossary.flush()
    await this.review.flush({ extraction: { version: this.options.sourceIndex?.extractionVersion ?? null, issues: this.options.sourceIndex?.issues ?? [], locationStatus: this.options.sourceIndex ? 'available' : 'unavailable' }, glossaryFile: this.glossary.file, terminologyConflicts: this.glossary.conflicts(), ...this.extra })
  }
}
