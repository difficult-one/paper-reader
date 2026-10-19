import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { prepareBlindReview, assessTranslationAcceptance } from '../src/main/translation-acceptance'

const cases = [
  { id: 'p1', documentId: 'paper1', discipline: 'engineering', source: 'The treatment had 10 events.', page: 2 },
  { id: 'p2', documentId: 'paper2', discipline: 'biology', source: 'The estimate may remain bounded.', page: 1 }
].map(sample => ({ ...sample, sourceHash: createHash('sha256').update(sample.source).digest('hex') }))
const runs = ['baseline', 'candidate'].flatMap(arm => cases.map(sample => ({ caseId: sample.id, arm: arm as 'baseline' | 'candidate', status: 'completed' as const, output: sample.id === 'p1' ? '治疗组有 10 起事件。' : '估计值可能保持有界。', policy: arm + '-policy', sourceHash: sample.sourceHash })))
const complete = () => {
  const material = prepareBlindReview(cases, runs, 'seed')
  const decisions = material.review.map(row => ({ blindId: row.blindId, status: 'reviewed' as const, reviewer: 'reviewer-1', reviewedAt: '2026-10-18', method: 'human' as const, issues: [] }))
  return { material, decisions }
}
const requirements = { paragraphs: 2, papers: 2, disciplines: 2 }
const policies = { baseline: 'baseline-policy', candidate: 'candidate-policy' }
it('keeps policy and arm out of blinded rows while retaining source locations', () => {
  const material = prepareBlindReview(cases, runs, 'seed')
  expect(material.review).toHaveLength(4)
  expect(new Set(material.review.map(row => row.blindId)).size).toBe(4)
  expect(material.review[0]).toHaveProperty('page')
  for (const row of material.review) { expect(row).not.toHaveProperty('arm'); expect(row).not.toHaveProperty('policy'); expect(row).not.toHaveProperty('sourceHash') }
  expect(material.key).toHaveLength(4)
  expect(material.review.map(row => row.blindId)).toEqual(prepareBlindReview(cases, runs, 'seed').review.map(row => row.blindId))
})
it('never releases partially translated or partially human-reviewed corpora', () => {
  const { material, decisions } = complete()
  const partial = runs.slice(0, 3)
  const available = material.key.filter(row => partial.some(run => run.caseId === row.caseId && run.arm === row.arm))
  const report = assessTranslationAcceptance(cases, partial, available, decisions.filter(row => available.some(key => key.blindId === row.blindId)), { requirements, layout: 'passed', costs: 'known' })
  expect(report.ready).toBe(false)
  expect(report.denominators.candidate.translated).toBe(1)
  expect(report.denominators.candidate.expected).toBe(2)
  expect(report.reasons).toContain('incomplete-translations')
  expect(report.reasons).toContain('incomplete-human-review')
})
it('rejects duplicate rows, source versions and fake quoted evidence', () => {
  expect(() => prepareBlindReview(cases, [...runs, runs[0]], 'seed')).toThrow(/duplicate/i)
  expect(() => prepareBlindReview(cases, [{ ...runs[0], sourceHash: 'wrong' }], 'seed')).toThrow(/source/i)
  expect(() => prepareBlindReview([{ ...cases[0], source: 'Altered source.' }], [], 'seed')).toThrow(/source/i)
  const { material, decisions } = complete()
  const invalid = [{ ...decisions[0], issues: [{ severity: 'critical', category: 'binding', sourceQuote: 'Invented text', translationQuote: '10', issue: 'Changed binding' }] }, ...decisions.slice(1)] as any
  expect(() => assessTranslationAcceptance(cases, runs, material.key, invalid, { requirements, layout: 'passed', costs: 'known' })).toThrow(/evidence/i)
})
it('does not count model decisions as human and blocks critical errors or unmeasured layout', () => {
  const { material, decisions } = complete()
  const agent = decisions.map(row => ({ ...row, method: 'agent' as const }))
  expect(assessTranslationAcceptance(cases, runs, material.key, agent, { requirements, layout: 'passed', costs: 'known' }).ready).toBe(false)
  expect(assessTranslationAcceptance(cases, runs, material.key, decisions, { requirements, layout: 'pending', costs: 'known' }).ready).toBe(false)
  const candidate = material.key.find(row => row.arm === 'candidate' && row.caseId === 'p1')!
  const bad = decisions.map(row => row.blindId === candidate.blindId ? { ...row, issues: [{ severity: 'critical' as const, category: 'binding', sourceQuote: '10 events', translationQuote: '10 起事件', issue: 'Confirmed changed group binding.' }] } : row)
  expect(assessTranslationAcceptance(cases, runs, material.key, bad, { requirements, layout: 'passed', costs: 'known' }).reasons).toContain('new-critical-errors')
})
it('reports explicit denominators and releases only a complete evidence set', () => {
  const { material, decisions } = complete()
  const report = assessTranslationAcceptance(cases, runs, material.key, decisions, { requirements, policies, layout: 'passed', costs: 'known' })
  expect(report.ready).toBe(true)
  expect(report.denominators.baseline).toMatchObject({ expected: 2, translated: 2, humanReviewed: 2, criticalParagraphs: 0, ordinaryErrorParagraphs: 0 })
  expect(report.denominators.candidate.humanReviewed).toBe(2)
  expect(report.byDiscipline.biology.candidate.expected).toBe(1)
  expect(report.byPaper.paper1.baseline.expected).toBe(1)
})
it('blocks a different new critical issue even when the two arms have equal critical counts', () => {
  const { material, decisions } = complete()
  const changed = decisions.map(row => {
    const mapping = material.key.find(key => key.blindId === row.blindId)!
    return mapping.caseId !== 'p1' ? row : { ...row, issues: [{ severity: 'critical' as const, category: mapping.arm === 'baseline' ? 'omission' : 'binding', sourceQuote: '10 events', translationQuote: '10 起事件', issue: mapping.arm === 'baseline' ? 'Original missing qualifier.' : 'New incorrect group binding.' }] }
  })
  const report = assessTranslationAcceptance(cases, runs, material.key, changed, { requirements, policies, layout: 'passed', costs: 'known' })
  expect(report.ready).toBe(false)
  expect(report.newCriticalCases).toEqual(['p1'])
})
it('cannot release an output whose recorded policy differs from the expected pair', () => {
  const { material, decisions } = complete()
  const stale = runs.map(run => run.arm === 'candidate' ? { ...run, policy: 'obsolete-policy' } : run)
  expect(assessTranslationAcceptance(cases, stale, material.key, decisions, { requirements, layout: 'passed', costs: 'known', policies: { baseline: 'baseline-policy', candidate: 'candidate-policy' } }).ready).toBe(false)
})
it('rejects a higher general error rate and decisions with no human identity', () => {
  const { material, decisions } = complete()
  const candidate = material.key.find(row => row.arm === 'candidate' && row.caseId === 'p1')!
  const worse = decisions.map(row => row.blindId === candidate.blindId ? { ...row, issues: [{ severity: 'major' as const, category: 'binding', sourceQuote: '10 events', translationQuote: '10 起事件', issue: 'Confirmed assignment error.' }] } : row)
  const report = assessTranslationAcceptance(cases, runs, material.key, worse, { requirements, layout: 'passed', costs: 'known' })
  expect(report.ready).toBe(false)
  expect(report.ordinaryErrorRate).toEqual({ baseline: 0, candidate: .5 })
  expect(report.reasons).toContain('higher-ordinary-error-rate')
  expect(() => assessTranslationAcceptance(cases, runs, material.key, decisions.map(row => ({ ...row, reviewer: '' })), { requirements, layout: 'passed', costs: 'known' })).toThrow(/identity/i)
})
