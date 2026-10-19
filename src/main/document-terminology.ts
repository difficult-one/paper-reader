import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatRequest } from './translation-gateway'
import { describePrefix, fingerprint } from './cache-diagnostics'
import { writeJson } from './store'

export interface Term { src: string; tgt: string }
interface Section { key: string; source: string; context: string; terms: (Term & { evidence: string })[] }
interface Glossary { version: number; scope: string; revision: number; sections: Section[] }
export interface TermPlan { body: ChatRequest; reusedTerms: Term[]; reusedSections: number; complete: boolean; missing: { key: string; source: string; context: string }[] }
export const uniqueTerms = (terms: Term[]): Term[] => [...new Map(terms.map(term => [JSON.stringify([term.src, term.tgt]), { src: term.src, tgt: term.tgt }])).values()]
export class DocumentTerminology {
  readonly file: string
  private scope: string
  private data?: Promise<Glossary>
  private writes: Promise<unknown> = Promise.resolve()
  constructor(directory: string, scope: { document: string; policy: string; model: string; service: string; extraction: string }) {
    this.scope = fingerprint(scope); this.file = join(directory, `${this.scope}.json`)
  }
  private load() {
    return this.data ??= readFile(this.file, 'utf8').then(raw => {
      const data = JSON.parse(raw) as Glossary
      if (data.version !== 1 || data.scope !== this.scope || !Number.isSafeInteger(data.revision) || !Array.isArray(data.sections) || data.sections.some(section => typeof section.source !== 'string' || typeof section.context !== 'string' || section.key !== fingerprint([section.context, section.source]) || !Array.isArray(section.terms) || section.terms.some(term => !term.src?.trim() || !term.tgt?.trim() || typeof term.evidence !== 'string'))) throw new Error('Invalid glossary')
      return data
    }).catch(() => ({ version: 1, scope: this.scope, revision: 0, sections: [] }))
  }
  async plan(body: ChatRequest): Promise<TermPlan | null> {
    if (describePrefix(body).type !== 'terminology' || body.messages.length !== 2) return null
    const user = body.messages[1].content
    const marker = 'Input Text:\n```\n'; const start = user.lastIndexOf(marker); const end = user.lastIndexOf('\n```')
    if (start < 0 || end <= start) return null
    const source = user.slice(start + marker.length, end)
    const { messages: _messages, ...parameters } = body
    const context = JSON.stringify([parameters, body.messages[0], user.slice(0, start)])
    // The engine returns src/tgt without source IDs. The entire original extraction
    // batch is therefore the smallest proven context/sense boundary we may reuse.
    const parts = source.trim() ? [source] : []
    if (!parts.length) return null
    const data = await this.load()
    const sections = parts.map(source => ({ key: fingerprint([context, source]), source, context }))
    const missing = sections.filter(section => !data.sections.some(saved => saved.key === section.key))
    const reusedTerms = uniqueTerms(sections.flatMap(section => data.sections.find(saved => saved.key === section.key)?.terms ?? []))
    // New text is always examined. A matching spelling alone never proves matching meaning.
    const candidates = uniqueTerms(data.sections.filter(section => section.context === context).flatMap(section => section.terms)).filter(term => missing.some(section => section.source.includes(term.src)))
    const unambiguous = candidates.filter(term => !candidates.some(other => other.src === term.src && other.tgt !== term.tgt))
    const reference = unambiguous.length ? `## Document terminology candidates, revision ${data.revision}\n${JSON.stringify(unambiguous)}\nReuse only if the local definition agrees; extract a distinct translation for a different meaning.\n\n` : ''
    return { body: { ...body, messages: [body.messages[0], { ...body.messages[1], content: `${user.slice(0, start)}${reference}${marker}${missing.map(section => section.source).join('\n\n')}${user.slice(end)}` }] }, reusedTerms, reusedSections: sections.length - missing.length, complete: !missing.length, missing }
  }
  async commit(plan: TermPlan, terms: Term[]) {
    const operation = this.writes.then(async () => {
      const data = await this.load()
      for (const section of plan.missing) {
        if (data.sections.some(saved => saved.key === section.key)) continue
        // Store provenance per source section, including successful empty extractions.
        data.sections.push({ ...section, terms: uniqueTerms(terms).filter(term => section.source.includes(term.src)).map(term => ({ ...term, evidence: section.source })) })
      }
      data.revision++
      await writeJson(this.file, data)
    })
    this.writes = operation.catch(() => {})
    await operation
  }
}
