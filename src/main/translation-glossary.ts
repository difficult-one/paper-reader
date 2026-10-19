import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ReviewParagraph } from './translation-review'
import { writeJson } from './store'

interface Term { src: string; tgt: string }
interface Entry extends Term { paragraphId: string; page: number | null; section: string; sourceQuote: string; definitionQuote: string | null; abbreviation: string | null; origin: 'user' | 'extracted' | 'supplied'; status: 'user-specified' | 'source-defined' | 'candidate' | 'conflict'; preferred: boolean }
export class TranslationGlossary {
  readonly file: string
  private entries: Entry[] = []
  constructor(private options: { directory: string; documentId: string; sourceVersion: string }) { this.file = join(options.directory, 'translation-glossary.json') }
  add(terms: Term[], origins: ReviewParagraph[], origin: Entry['origin']) {
    for (const term of terms) for (const source of origins) {
      if (typeof term?.src !== 'string' || !term.src.trim() || typeof term?.tgt !== 'string' || !term.tgt.trim()) continue
      const escaped = term.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const exactTerm = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u')
      if (!exactTerm.test(source.source)) continue
      if (this.entries.some(entry => entry.src === term.src && entry.tgt === term.tgt && entry.section === source.section && entry.paragraphId === source.paragraphId && entry.origin === origin)) continue
      // A source occurrence is evidence of use; only an explicit local construction is a definition.
      const sentences = source.source.match(/[^.!?]+(?:[.!?]|$)/g) ?? [source.source]
      const definitionSubject = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?:\\s+\\([^()\\r\\n]{1,150}\\))?\\s+(?:is defined as|are defined as|means|denotes|refers to)\\b`, 'u')
      const definition = sentences.find(sentence => definitionSubject.test(sentence))?.trim() ?? null
      this.entries.push({ src: term.src, tgt: term.tgt, paragraphId: source.paragraphId, page: source.page, section: source.section, sourceQuote: source.source, definitionQuote: definition, abbreviation: /^[A-Z][A-Z0-9-]{1,12}$/.test(term.src) ? term.src : null, origin, status: origin === 'user' ? 'user-specified' : definition ? 'source-defined' : 'candidate', preferred: origin === 'user' })
    }
    for (const entry of this.entries) {
      const conflict = this.entries.some(other => other !== entry && other.src === entry.src && other.section === entry.section && other.tgt !== entry.tgt)
      entry.status = conflict ? 'conflict' : entry.origin === 'user' ? 'user-specified' : entry.definitionQuote ? 'source-defined' : 'candidate'
    }
  }
  conflicts() {
    return [...new Set(this.entries.filter(entry => entry.status === 'conflict').map(entry => JSON.stringify([entry.src, entry.section])))].map(key => {
      const [src, section] = JSON.parse(key)
      return { src, section, entries: this.entries.filter(entry => entry.src === src && entry.section === section) }
    })
  }
  async flush() {
    const version = createHash('sha256').update(JSON.stringify([this.options.documentId, this.options.sourceVersion, this.entries])).digest('hex')
    await writeJson(this.file, { schemaVersion: 1, ...this.options, version, entries: this.entries, conflicts: this.conflicts() })
  }
}
