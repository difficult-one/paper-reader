import type { TranslationStrategy } from './translation-strategy'

export function experimentSchedule(options: { documents: string[]; repetitions: number; seed: number }) {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 3) throw new Error('至少重复三次。')
  const runs: { document: string; strategy: TranslationStrategy; cacheState: 'cold' | 'warm'; repetition: number; cacheNamespace: string }[] = []
  for (const document of options.documents) for (const strategy of ['baseline', 'terminology', 'adaptive'] as const) for (const cacheState of ['cold', 'warm'] as const) for (let repetition = 0; repetition < options.repetitions; repetition++) {
    runs.push({ document, strategy, cacheState, repetition, cacheNamespace: `${document}-${strategy}-${cacheState}-${repetition}` })
  }
  let state = options.seed >>> 0
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  for (let i = runs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [runs[i], runs[j]] = [runs[j], runs[i]] }
  return runs
}
export interface ReleaseMetrics { documents: number; disciplines: number; paragraphs: number; blindReviews: number; seriousErrors: number; ordinaryErrors: number; baselineOrdinaryErrors: number; costReduction: number; p95LatencyRatio: number; unknownCosts: number }
export function releaseAssessment(metrics: ReleaseMetrics) {
  const reasons: string[] = []
  if (metrics.documents < 10 || metrics.disciplines < 3 || metrics.paragraphs < 200) reasons.push('语料不足：至少 10 篇、3 学科、200 段。')
  if (metrics.blindReviews < metrics.paragraphs) reasons.push('原文盲评尚未完整完成。')
  if (metrics.seriousErrors > 0) reasons.push('存在新增严重语义错误。')
  if (metrics.ordinaryErrors > metrics.baselineOrdinaryErrors) reasons.push('普通错误高于基线。')
  if (!Number.isFinite(metrics.costReduction) || metrics.costReduction < .2) reasons.push('同质量费用降幅未达到 20%。')
  if (!Number.isFinite(metrics.p95LatencyRatio) || metrics.p95LatencyRatio > 1.1) reasons.push('P95 耗时劣化超过 10%。')
  if (metrics.unknownCosts > 0) reasons.push('存在未知费用。')
  return { ready: reasons.length === 0, reasons }
}
