import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import reviewRules from '../../skills/research-bilingual-translation/references/review-rules.md?raw'
import type { HighlightRect } from '../shared/types'
import { writeJson } from './store'
import { qualityParagraph } from './translation-quality'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const REVIEW_POLICY_VERSION = `semantic-review-v2-${hash(reviewRules.trim())}`
export const SEMANTIC_REVIEW_RULES = reviewRules.trim()
export interface ReviewParagraph { paragraphId: string; source: string; output: string; page: number | null; section: string; rects: HighlightRect[]; contextFingerprint?: string }
const categories = ['negation', 'condition', 'strength', 'statistics', 'binding', 'limitation', 'terminology', 'other'] as const
export interface SemanticIssue { category: typeof categories[number]; severity: 'critical' | 'major' | 'minor'; sourceQuote: string; translationQuote: string; issue: string }
interface ReviewResult { paragraphId: string; issues: SemanticIssue[] }
export function semanticRiskCategories(source: string): string[] {
  const patterns = {
    negation: /\b(?:not|no|never|neither|without|except|unless|fail(?:s|ed)? to)\b/i,
    condition: /\b(?:if|unless|only if|assuming|provided|necessary|sufficient|subject to)\b/i,
    strength: /\b(?:may|might|could|suggest\w*|associat\w*|caus\w*|correlat\w*)\b/i,
    statistics: /\b(?:significan\w*|equivalen\w*|non.?inferior\w*|confidence|percentage points?|p\s*[<=>])|\bCI\b|%/i,
    binding: /\d[\s\S]*\b(?:group|control|treatment|respectively|versus|vs\.?|compared)\b|\b(?:group|control|treatment|respectively|versus|vs\.?)\b[\s\S]*\d|\b[A-Z]\w*\s*=\s*\d/i,
    limitation: /\b(?:bounded|convergen\w*|stable|stability|limitation\w*|under|limited|failure|only)\b/i
  }
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(source)).map(([name]) => name)
}
export function parseSemanticReview(content: string, paragraphs: ReviewParagraph[]): ReviewResult[] | null {
  try {
    const values = JSON.parse(content)
    if (!Array.isArray(values) || values.length !== paragraphs.length || new Set(values.map(value => value?.paragraphId)).size !== paragraphs.length) return null
    for (const value of values) {
      const original = paragraphs.find(paragraph => paragraph.paragraphId === value?.paragraphId)
      if (!original || !Array.isArray(value.issues)) return null
      for (const issue of value.issues) if (!issue || !categories.includes(issue.category) || !['critical', 'major', 'minor'].includes(issue.severity) || typeof issue.issue !== 'string' || !issue.issue.trim() || typeof issue.sourceQuote !== 'string' || !issue.sourceQuote.trim() || !original.source.includes(issue.sourceQuote) || typeof issue.translationQuote !== 'string' || !issue.translationQuote.trim() || !original.output.includes(issue.translationQuote)) return null
    }
    return values.map(value => ({ paragraphId: value.paragraphId, issues: value.issues.map((issue: SemanticIssue) => ({ category: issue.category, severity: issue.severity, sourceQuote: issue.sourceQuote, translationQuote: issue.translationQuote, issue: issue.issue })) }))
  } catch { return null }
}

export class TranslationReview {
  readonly file: string
  private records = new Map<string, ReviewParagraph & { translationHash: string; structuralStatus: string; semanticStatus: string; reviewMethod: string; humanReview: string; risks: string[]; issues: SemanticIssue[]; reviewCacheHit: boolean }>()
  private checked = new Set<string>()
  private pending = new Map<string, Promise<void>>()
  private writes: Promise<void> = Promise.resolve()
  constructor(private options: { directory: string; documentId: string; sourceVersion: string; translationPolicy: string; sampleRate?: number; cacheDirectory?: string; reviewer?: string }) {
    this.file = join(options.directory, 'translation-quality-report.json')
  }
  async check(paragraphs: ReviewParagraph[], send: (items: ReviewParagraph[]) => Promise<string>): Promise<void> {
    const selected: ReviewParagraph[] = []; const waits: Promise<void>[] = []; const keys: string[] = []
    for (const paragraph of paragraphs) {
      const key = hash([this.options.documentId, this.options.sourceVersion, paragraph, this.options.reviewer, this.options.translationPolicy, REVIEW_POLICY_VERSION])
      if (this.checked.has(key)) continue
      if (keys.includes(key)) continue
      if (this.pending.has(key)) { waits.push(this.pending.get(key)!); continue }
      const risks = semanticRiskCategories(paragraph.source)
      const valid = qualityParagraph(paragraph.source, paragraph.output)
      const record = { ...paragraph, translationHash: hash(paragraph.output), structuralStatus: valid ? 'passed' : 'failed', semanticStatus: valid ? 'pending' : 'unresolved', reviewMethod: 'deterministic', humanReview: 'pending', risks, reviewCacheHit: false, issues: valid ? [] as SemanticIssue[] : [{ category: 'other', severity: 'major', sourceQuote: paragraph.source, translationQuote: paragraph.output, issue: '译文缺失，或结构、数值、引用标识检查未通过。' } satisfies SemanticIssue] }
      this.records.set(key, record)
      if (!valid) { this.checked.add(key); continue }
      const sample = parseInt(hash([this.options.documentId, paragraph.paragraphId]).slice(0, 8), 16) / 0x100000000
      if (risks.length || sample < (this.options.sampleRate ?? .05)) { selected.push(paragraph); keys.push(key) }
      else this.checked.add(key)
    }
    if (selected.length) {
      // Claim synchronously before yielding so overlapping callers pay only once.
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      keys.forEach(key => this.pending.set(key, pending))
      try {
        const results: ReviewResult[] = []
        const missing: ReviewParagraph[] = []
        for (let i = 0; i < selected.length; i++) {
          let cached: ReviewResult[] | null = null
          if (this.options.cacheDirectory) try {
            const saved = JSON.parse(await readFile(join(this.options.cacheDirectory, `${keys[i]}.json`), 'utf8'))
            if (saved.version === 1 && saved.key === keys[i]) cached = parseSemanticReview(JSON.stringify(saved.results), [selected[i]])
          } catch { /* A missing or malformed review is not a pass. */ }
          if (cached) { results.push(...cached); this.records.get(keys[i])!.reviewCacheHit = true }
          else missing.push(selected[i])
        }
        if (missing.length) {
          const fresh = parseSemanticReview(await send(missing), missing)
          if (fresh) {
            results.push(...fresh)
            if (this.options.cacheDirectory) for (const result of fresh) {
              const key = keys[selected.findIndex(paragraph => paragraph.paragraphId === result.paragraphId)]
              await writeJson(join(this.options.cacheDirectory, `${key}.json`), { version: 1, key, results: [result] }).catch(() => {})
            }
          }
        }
        for (const key of keys) {
          const record = this.records.get(key)!
          const result = results.find(value => value.paragraphId === record.paragraphId)
          if (result) { record.issues = result.issues; record.semanticStatus = result.issues.length ? 'unresolved' : 'model-passed'; record.reviewMethod = 'model' }
          else record.reviewMethod = 'model-incomplete'
          this.checked.add(key)
        }
      } catch {
        for (const key of keys) { this.records.get(key)!.reviewMethod = 'model-incomplete'; this.checked.add(key) }
      } finally { keys.forEach(key => this.pending.delete(key)); release() }
    }
    await Promise.all(waits)
  }
  async flush(extra: Record<string, unknown> = {}): Promise<void> {
    await Promise.all([...this.pending.values()])
    const paragraphs = [...this.records.values()]
    const issues = paragraphs.flatMap(paragraph => paragraph.issues.map(issue => ({ ...issue, documentId: this.options.documentId, sourceVersion: this.options.sourceVersion, paragraphId: paragraph.paragraphId, page: paragraph.page, section: paragraph.section, rects: paragraph.rects, translationHash: paragraph.translationHash, status: 'unresolved', reviewMethod: paragraph.reviewMethod, ruleVersion: REVIEW_POLICY_VERSION })))
    const report = { schemaVersion: 1, documentId: this.options.documentId, sourceVersion: this.options.sourceVersion, translationPolicy: this.options.translationPolicy, ruleVersion: REVIEW_POLICY_VERSION, coverageStatus: paragraphs.length ? 'observed-paragraphs-only' : 'unobserved', generatedAt: new Date().toISOString(), summary: { total: paragraphs.length, structuralPassed: paragraphs.filter(p => p.structuralStatus === 'passed').length, modelReviewed: paragraphs.filter(p => p.reviewMethod === 'model').length, unresolved: paragraphs.filter(p => p.semanticStatus === 'unresolved').length, semanticPending: paragraphs.filter(p => p.semanticStatus === 'pending').length }, paragraphs, issues, ...extra }
    this.writes = this.writes.catch(() => {}).then(() => writeJson(this.file, report))
    await this.writes
  }
}
