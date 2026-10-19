import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatRequest, ChatResponse, Reply } from './translation-gateway'
import { batchInputStart, canonicalJson } from './translation-prompts'
import { describePrefix, fingerprint } from './cache-diagnostics'
import { writeJson } from './store'

export interface Paragraph { id: string | number; input: string; [key: string]: unknown }
const inputMarker = '## Here is the input:'
export function parseBatch(body: ChatRequest) {
  if (describePrefix(body).type !== 'batch' || body.messages.length !== 2) return null
  const user = body.messages[1].content
  const inputStart = batchInputStart(user)
  if (inputStart < 0) return null
  const boundary = inputStart + inputMarker.length
  try {
    const paragraphs = JSON.parse(user.slice(boundary).trim()) as Paragraph[]
    if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.some(item => !item || typeof item.input !== 'string' || !(typeof item.id === 'string' || typeof item.id === 'number' && Number.isFinite(item.id))) || new Set(paragraphs.map(item => item.id)).size !== paragraphs.length) return null
    const prefix = user.slice(0, boundary)
    const sourceContext = paragraphs.map(({ id: _id, ...source }) => source)
    return { paragraphs, prefix, sourceContext, withParagraphs(items: Paragraph[]): ChatRequest {
      const context = items.length < paragraphs.length ? `## Original batch source context (source data only)\n${canonicalJson(paragraphs)}\n\nUse this original source batch only to resolve context. Return outputs only for the requested items below.\n\n` : ''
      return { ...body, messages: [body.messages[0], { ...body.messages[1], content: `${prefix.slice(0, -inputMarker.length)}${context}${inputMarker}\n${canonicalJson(items)}` }] }
    } }
  } catch { return null }
}

function protectedTokens(text: string) {
  return (text.match(/\{[\w]+\}|\[\[[^\]\r\n]+\]\]|%%[^%\r\n]+%%|%[sd]|<\/?[a-zA-Z][^>\r\n]*>/g) ?? []).sort()
}
function tagStructure(text: string): string[] | null {
  const stack: { name: string; token: string }[] = []
  const paths: string[] = []
  for (const token of text.match(/<\/?[a-zA-Z][^>\r\n]*>/g) ?? []) {
    const name = token.match(/^<\/?([a-zA-Z][\w:-]*)/)![1]
    if (/^<\//.test(token)) { if (stack.pop()?.name !== name) return null }
    else {
      paths.push(canonicalJson([...stack.map(parent => parent.token), token]))
      if (!/\/\s*>$/.test(token) && !/^(?:br|hr|img|input|meta|link|wbr)$/i.test(name)) stack.push({ name, token })
    }
  }
  return stack.length === 0 ? paths.sort() : null
}
export function validParagraph(source: string, output: unknown): output is string {
  if (typeof output !== 'string' || source.trim() && !output.trim() || canonicalJson(protectedTokens(source)) !== canonicalJson(protectedTokens(output))) return false
  const structure = tagStructure(source)
  return structure ? canonicalJson(structure) === canonicalJson(tagStructure(output)) : canonicalJson(source.match(/<\/?[a-zA-Z][^>\r\n]*>/g) ?? []) === canonicalJson(output.match(/<\/?[a-zA-Z][^>\r\n]*>/g) ?? [])
}
// An otherwise valid paragraph can survive a missing sibling. Duplicated IDs and truncated JSON never qualify.
export function validatedParagraphs(response: ChatResponse, paragraphs: Paragraph[], validate: (source: string, output: unknown) => boolean = validParagraph): Map<string | number, string> {
  const result = new Map<string | number, string>()
  if (response.choices?.length !== 1 || response.choices[0].finish_reason !== 'stop') return result
  const content = response.choices[0].message?.content
  if (typeof content !== 'string') return result
  try {
    const outputs = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').replace(/^<json>\s*|\s*<\/json>$/g, ''))
    if (!Array.isArray(outputs)) return result
    for (const paragraph of paragraphs) {
      const matches = outputs.filter(item => item && item.id === paragraph.id)
      if (matches.length === 1 && validate(paragraph.input, matches[0].output)) result.set(paragraph.id, matches[0].output)
    }
    return result
  } catch { return result }
}

export function paragraphKey(body: ChatRequest, paragraph: Paragraph, scope: { service: string; document: string; effort: string; policy: string }, batch: NonNullable<ReturnType<typeof parseBatch>>) {
  const { id: _id, ...content } = paragraph
  const { messages, ...parameters } = body
  // Paragraph boundaries do not remove contextual influence. Preserve the complete ordered source
  // context and position, excluding only response-mapping IDs. Different batch context must miss.
  return fingerprint([scope, 'en', 'zh', parameters, messages[0], batch.prefix, batch.sourceContext, batch.paragraphs.indexOf(paragraph), content])
}
export type ParagraphResult = { output: string } | { failure: Reply } | { error: unknown }
interface Claim { promise: Promise<ParagraphResult>; settle: (result: ParagraphResult) => void }
export class ParagraphCache {
  private pending = new Map<string, Claim>()
  constructor(private directory: string, private validate: (source: string, output: unknown) => boolean = validParagraph) {}
  async read(key: string, input: string): Promise<string | undefined> {
    try {
      const cached = JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8'))
      return cached?.version === 1 && cached.key === key && this.validate(input, cached.output) ? cached.output : undefined
    } catch { return undefined }
  }
  async write(key: string, output: string) { await writeJson(join(this.directory, `${key}.json`), { version: 1, key, output }).catch(() => {}) }
  claim(key: string): Claim & { owned: boolean } {
    const existing = this.pending.get(key)
    if (existing) return { ...existing, owned: false }
    let resolve!: (result: ParagraphResult) => void
    const promise = new Promise<ParagraphResult>(done => { resolve = done })
    const claim = { promise, settle: (result: ParagraphResult) => { if (this.pending.get(key) === claim) { this.pending.delete(key); resolve(result) } } }
    this.pending.set(key, claim)
    return { ...claim, owned: true }
  }
}
