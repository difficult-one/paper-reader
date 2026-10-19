import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationReview, semanticRiskCategories, parseSemanticReview } from '../src/main/translation-review'
import { TranslationGlossary } from '../src/main/translation-glossary'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'translation-qa-')); dirs.push(dir); return dir }
const item = { paragraphId: 'p1', source: 'The treatment group had 10 events and control had 20 events.', output: '治疗组有 20 起事件，对照组有 10 起事件。', page: 2, section: 'Results', rects: [] }
const issue = { category: 'binding', severity: 'critical', sourceQuote: 'treatment group had 10 events', translationQuote: '治疗组有 20 起事件', issue: '组别与数值对应关系被交换。' }
it('flags semantic risks including unchanged numeric sets, and samples low-risk paragraphs', () => {
  expect(semanticRiskCategories(item.source)).toContain('binding')
  expect(semanticRiskCategories('The effect may not occur unless the resistance is constant.')).toEqual(expect.arrayContaining(['negation', 'condition', 'strength']))
  expect(semanticRiskCategories('A bounded estimate is not necessarily convergent.')).toContain('limitation')
})
it('accepts review evidence only for requested IDs and verbatim source/translation quotes', () => {
  expect(parseSemanticReview(JSON.stringify([{ paragraphId: 'p1', issues: [issue] }]), [item])?.[0].issues).toEqual([issue])
  for (const value of [[], [{ paragraphId: 'other', issues: [] }], [{ paragraphId: 'p1', issues: [{ ...issue, sourceQuote: 'invented' }] }], [{ paragraphId: 'p1', issues: [] }, { paragraphId: 'p1', issues: [] }]]) {
    expect(parseSemanticReview(JSON.stringify(value), [item])).toBeNull()
  }
  expect(parseSemanticReview('[', [item])).toBeNull()
})
it('persists independent states, deduplicates paid review, and never mutates the translation', async () => {
  const dir = await directory(); let calls = 0
  const review = new TranslationReview({ directory: dir, documentId: 'paper', sourceVersion: 'v1', translationPolicy: 't1', sampleRate: 1 })
  const send = async () => { calls++; return JSON.stringify([{ paragraphId: 'p1', issues: [issue] }]) }
  await Promise.all([review.check([item], send), review.check([item], send)])
  await review.flush()
  const report = JSON.parse(await readFile(review.file, 'utf8'))
  expect(calls).toBe(1)
  expect(report.paragraphs[0]).toMatchObject({ paragraphId: 'p1', page: 2, structuralStatus: 'passed', semanticStatus: 'unresolved', reviewMethod: 'model' })
  expect(report.issues[0]).toMatchObject({ ...issue, documentId: 'paper', sourceVersion: 'v1', paragraphId: 'p1', status: 'unresolved' })
  expect(item.output).toBe('治疗组有 20 起事件，对照组有 10 起事件。')
  expect(report.paragraphs[0].humanReview).toBe('pending')
})
it('never records model pass after truncation, missing IDs, or a failed request', async () => {
  const dir = await directory()
  const review = new TranslationReview({ directory: dir, documentId: 'paper', sourceVersion: 'v1', translationPolicy: 't1', sampleRate: 1 })
  await review.check([item], async () => '[]'); await review.flush()
  expect(JSON.parse(await readFile(review.file, 'utf8')).paragraphs[0].semanticStatus).toBe('pending')
})

it('reuses a validated review across jobs only for the same source, output and reviewer', async () => {
  const dir = await directory(); let calls = 0
  const options = { directory: join(dir, 'first'), documentId: 'paper', sourceVersion: 'v1', translationPolicy: 't1', cacheDirectory: join(dir, 'cache'), reviewer: 'service:model:high', sampleRate: 1 }
  const send = async () => { calls++; return JSON.stringify([{ paragraphId: 'p1', issues: [] }]) }
  await new TranslationReview(options).check([item], send)
  const next = new TranslationReview({ ...options, directory: join(dir, 'second') })
  await next.check([item], send); await next.flush()
  expect(calls).toBe(1)
  expect(JSON.parse(await readFile(next.file, 'utf8')).paragraphs[0]).toMatchObject({ semanticStatus: 'model-passed', reviewCacheHit: true })
  await new TranslationReview({ ...options, reviewer: 'other:model' }).check([item], send)
  await new TranslationReview(options).check([{ ...item, output: '治疗组有 10 起事件，对照组有 20 起事件。' }], send)
  expect(calls).toBe(3)
})
it('retains low-risk pending state without issuing a model request when not sampled', async () => {
  const dir = await directory(); let calls = 0
  const review = new TranslationReview({ directory: dir, documentId: 'paper', sourceVersion: 'v1', translationPolicy: 't1', sampleRate: 0 })
  await review.check([{ ...item, source: 'This is a simple title.', output: '这是简单标题。' }], async () => { calls++; return '' }); await review.flush()
  expect(calls).toBe(0)
  expect(JSON.parse(await readFile(review.file, 'utf8')).paragraphs[0].semanticStatus).toBe('pending')
})
it('records real definition excerpts, scoped conflicts and user preferences without model confidence', async () => {
  const dir = await directory(); const glossary = new TranslationGlossary({ directory: dir, documentId: 'paper', sourceVersion: 'v1' })
  const origin = { ...item, source: 'ABC is defined as adaptive boundary correction.' }
  glossary.add([{ src: 'ABC', tgt: '自适应边界校正' }], [origin], 'extracted')
  glossary.add([{ src: 'ABC', tgt: '用户译法' }], [origin], 'user')
  glossary.add([{ src: 'ABC', tgt: '另一个定义' }], [{ ...origin, section: 'Appendix', paragraphId: 'p2' }], 'extracted')
  glossary.add([{ src: 'XYZ', tgt: '猜测定义', confidence: 1 } as any], [origin], 'extracted')
  await glossary.flush()
  const result = JSON.parse(await readFile(glossary.file, 'utf8'))
  expect(result.entries).toHaveLength(3)
  expect(result.entries.find((entry: any) => entry.origin === 'user').preferred).toBe(true)
  expect(result.entries.find((entry: any) => entry.origin === 'user').tgt).toBe('用户译法')
  expect(result.entries.find((entry: any) => entry.section === 'Results' && entry.origin === 'extracted')).toMatchObject({ status: 'conflict', definitionQuote: origin.source, page: 2 })
  expect(result.entries.find((entry: any) => entry.section === 'Appendix').status).toBe('source-defined')
  expect(glossary.conflicts()).toHaveLength(1)
})
it('does not mistake another term’s definition or a substring for this term’s definition', async () => {
  const dir = await directory(); const glossary = new TranslationGlossary({ directory: dir, documentId: 'paper', sourceVersion: 'v1' })
  glossary.add([{ src: 'ABC', tgt: '候选术语' }, { src: 'BC', tgt: '错误子串' }], [{ ...item, source: 'ABC is used here; XYZ is defined as the sample size.' }], 'extracted')
  await glossary.flush()
  const result = JSON.parse(await readFile(glossary.file, 'utf8'))
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0]).toMatchObject({ status: 'candidate', definitionQuote: null })
})
