import { createHash } from 'node:crypto'
import { qualityParagraph } from './translation-quality'

export type AcceptanceArm = 'baseline' | 'candidate'
export interface AcceptanceCase { id: string; documentId: string; discipline: string; source: string; page: number; sourceHash: string; documentSha256?: string; sourceUrl?: string; rect?: number[] }
export interface AcceptanceRun { caseId: string; arm: AcceptanceArm; status: 'completed' | 'failed' | 'missing'; output: string; policy: string; sourceHash: string }
export interface BlindKey { blindId: string; caseId: string; arm: AcceptanceArm; sourceHash: string; outputHash: string }
export interface BlindDecision { blindId: string; status: 'reviewed' | 'pending' | 'unjudgeable'; reviewer: string; reviewedAt: string; method: 'human' | 'agent'; issues: { severity: 'critical' | 'major' | 'minor'; category: string; sourceQuote: string; translationQuote: string; issue: string }[] }
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const arms: AcceptanceArm[] = ['baseline', 'candidate']
const runKey = (run: Pick<AcceptanceRun, 'caseId' | 'arm'>) => JSON.stringify([run.caseId, run.arm])

export function prepareBlindReview(cases: AcceptanceCase[], runs: AcceptanceRun[], seed: string) {
  if (!seed.trim() || new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('Invalid seed or duplicate cases')
  if (cases.some(sample => sha(sample.source) !== sample.sourceHash)) throw new Error('Frozen source hash does not match its actual text')
  const seen = new Set<string>()
  const key: BlindKey[] = []
  const review: { blindId: string; source: string; translation: string; documentId: string; page: number; sourceUrl?: string; rect?: number[]; status: 'pending'; reviewer: string; reviewedAt: string; method: 'human'; issues: [] }[] = []
  for (const run of runs) {
    const id = runKey(run); const sample = cases.find(sample => sample.id === run.caseId)
    if (seen.has(id)) throw new Error('Duplicate run')
    seen.add(id)
    if (!sample || !arms.includes(run.arm) || sample.sourceHash !== run.sourceHash) throw new Error('Run source version does not match frozen case')
    if (run.status !== 'completed' || !run.output.trim()) continue
    const outputHash = sha(run.output)
    const blindId = sha(JSON.stringify([seed, run.caseId, run.arm, run.sourceHash, outputHash])).slice(0, 32)
    key.push({ blindId, caseId: run.caseId, arm: run.arm, sourceHash: run.sourceHash, outputHash })
    review.push({ blindId, source: sample.source, translation: run.output, documentId: sample.documentId, page: sample.page, sourceUrl: sample.sourceUrl, rect: sample.rect, status: 'pending', reviewer: '', reviewedAt: '', method: 'human', issues: [] })
  }
  // Opaque, seed-derived ordering hides the arm and does not depend on input/run order.
  review.sort((a, b) => a.blindId.localeCompare(b.blindId))
  return { schemaVersion: 1, review, key }
}

const counters = () => ({ expected: 0, translated: 0, structurePassed: 0, humanReviewed: 0, agentReviewed: 0, unjudgeable: 0, criticalParagraphs: 0, ordinaryErrorParagraphs: 0 })
type Counts = ReturnType<typeof counters>
type ArmCounts = Record<AcceptanceArm, Counts>
const armCounters = (): ArmCounts => ({ baseline: counters(), candidate: counters() })

export function assessTranslationAcceptance(cases: AcceptanceCase[], runs: AcceptanceRun[], key: BlindKey[], decisions: BlindDecision[], options: { requirements?: { paragraphs: number; papers: number; disciplines: number }; policies?: Record<AcceptanceArm, string>; layout: 'passed' | 'pending' | 'failed'; costs: 'known' | 'unknown' }) {
  // Validate all source versions and unique run identities, including failures.
  prepareBlindReview(cases, runs, 'validate')
  if (new Set(key.map(item => item.blindId)).size !== key.length || new Set(key.map(runKey)).size !== key.length) throw new Error('Duplicate blind key')
  if (new Set(decisions.map(item => item.blindId)).size !== decisions.length) throw new Error('Duplicate review decision')
  const verified = new Map<string, BlindDecision>()
  for (const decision of decisions) {
    const mapping = key.find(item => item.blindId === decision.blindId)
    const sample = cases.find(item => item.id === mapping?.caseId)
    const run = runs.find(run => mapping && runKey(run) === runKey(mapping))
    if (!mapping || !sample || !run || mapping.sourceHash !== sample.sourceHash || mapping.outputHash !== sha(run.output) || run.status !== 'completed') throw new Error('Review evidence does not match source/output version')
    if (!['reviewed', 'pending', 'unjudgeable'].includes(decision.status) || !['human', 'agent'].includes(decision.method) || !Array.isArray(decision.issues)) throw new Error('Invalid review decision')
    if (decision.status === 'reviewed' && (!decision.reviewer?.trim() || !decision.reviewedAt || !Number.isFinite(Date.parse(decision.reviewedAt)))) throw new Error('Reviewed decision requires reviewer identity and date')
    for (const issue of decision.issues) {
      if (!['critical', 'major', 'minor'].includes(issue.severity) || !issue.category?.trim() || !issue.issue?.trim() || !issue.sourceQuote?.trim() || !sample.source.includes(issue.sourceQuote) || !issue.translationQuote?.trim() || !run.output.includes(issue.translationQuote)) throw new Error('Invalid review evidence quotes')
    }
    verified.set(runKey(run), decision)
  }
  const denominators = armCounters()
  const byDiscipline: Record<string, ArmCounts> = {}
  const byPaper: Record<string, ArmCounts> = {}
  const critical = (caseId: string, arm: AcceptanceArm) => verified.get(JSON.stringify([caseId, arm]))?.issues.filter(issue => issue.severity === 'critical').map(issue => JSON.stringify([issue.category, issue.sourceQuote, issue.issue])) ?? []
  for (const sample of cases) for (const arm of arms) {
    const run = runs.find(run => run.arm === arm && run.caseId === sample.id)
    const decision = run && verified.get(runKey(run))
    const targets = [denominators[arm], (byDiscipline[sample.discipline] ??= armCounters())[arm], (byPaper[sample.documentId] ??= armCounters())[arm]]
    for (const counts of targets) {
      counts.expected++
      if (run?.status !== 'completed' || !run.output.trim()) continue
      counts.translated++
      if (qualityParagraph(sample.source, run.output)) counts.structurePassed++
      if (decision?.status === 'unjudgeable') counts.unjudgeable++
      if (decision?.status !== 'reviewed') continue
      if (decision.method === 'agent') { counts.agentReviewed++; continue }
      counts.humanReviewed++
      if (decision.issues.some(issue => issue.severity === 'critical')) counts.criticalParagraphs++
      if (decision.issues.some(issue => issue.severity !== 'critical')) counts.ordinaryErrorParagraphs++
    }
  }
  const requirements = options.requirements ?? { paragraphs: 200, papers: 10, disciplines: 3 }
  const reasons: string[] = []
  if (!options.policies?.baseline || !options.policies.candidate || runs.some(run => run.policy !== options.policies![run.arm])) reasons.push('stale-or-unspecified-policies')
  if (cases.length < requirements.paragraphs || Object.keys(byPaper).length < requirements.papers || Object.keys(byDiscipline).length < requirements.disciplines) reasons.push('insufficient-corpus')
  if (arms.some(arm => denominators[arm].translated !== cases.length)) reasons.push('incomplete-translations')
  if (arms.some(arm => denominators[arm].humanReviewed !== cases.length)) reasons.push('incomplete-human-review')
  if (denominators.candidate.structurePassed !== cases.length) reasons.push('candidate-structure-failures')
  // A replaced critical error is still new, even when the paragraph's total is unchanged.
  const newCriticalCases = cases.filter(sample => critical(sample.id, 'candidate').some(issue => !critical(sample.id, 'baseline').includes(issue))).map(sample => sample.id)
  if (newCriticalCases.length) reasons.push('new-critical-errors')
  const rate = (arm: AcceptanceArm) => denominators[arm].humanReviewed ? denominators[arm].ordinaryErrorParagraphs / denominators[arm].humanReviewed : null
  const baselineRate = rate('baseline'); const candidateRate = rate('candidate')
  if (baselineRate !== null && candidateRate !== null && candidateRate > baselineRate) reasons.push('higher-ordinary-error-rate')
  if (options.layout !== 'passed') reasons.push('layout-not-passed')
  if (options.costs !== 'known') reasons.push('unknown-costs')
  return { schemaVersion: 1, ready: reasons.length === 0, reasons, requirements, denominators, byDiscipline, byPaper, newCriticalCases, ordinaryErrorRate: { baseline: baselineRate, candidate: candidateRate }, layout: options.layout, costs: options.costs }
}
