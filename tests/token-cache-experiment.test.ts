import { expect, it } from 'vitest'
import { experimentSchedule, releaseAssessment } from '../src/main/token-cache-experiment'
it('固定种子随机化策略/冷暖缓存顺序，每个组合重复三次，冷缓存不靠清空旧缓存产生', () => {
  const options = { documents: ['a', 'b'], seed: 42, repetitions: 3 }
  const schedule = experimentSchedule(options)
  expect(schedule).toEqual(experimentSchedule(options))
  expect(schedule).toHaveLength(36)
  expect(new Set(schedule.map(run => run.cacheNamespace)).size).toBe(36)
  for (const doc of ['a', 'b']) for (const strategy of ['baseline', 'terminology', 'adaptive']) for (const cacheState of ['cold', 'warm']) {
    expect(schedule.filter(run => run.document === doc && run.strategy === strategy && run.cacheState === cacheState)).toHaveLength(3)
  }
})
it('离线结构通过仍不能发布；盲评不足、有严重错误、未知费用或未达经济目标阻断发布结论', () => {
  const assessment = releaseAssessment({ documents: 2, disciplines: 1, paragraphs: 20, blindReviews: 0, seriousErrors: 0, ordinaryErrors: 0, baselineOrdinaryErrors: 0, costReduction: .3, p95LatencyRatio: 1, unknownCosts: 0 })
  expect(assessment.ready).toBe(false); expect(assessment.reasons.length).toBeGreaterThan(0)
  expect(releaseAssessment({ documents: 10, disciplines: 3, paragraphs: 200, blindReviews: 200, seriousErrors: 0, ordinaryErrors: 1, baselineOrdinaryErrors: 2, costReduction: .2, p95LatencyRatio: 1.1, unknownCosts: 0 }).ready).toBe(true)
})
