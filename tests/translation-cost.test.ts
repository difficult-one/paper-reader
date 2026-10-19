import { expect, it } from 'vitest'
import { modelCost, outputBreakdown, UsageBudget } from '../src/main/translation-cost'

const rates = { hit: 0.006, miss: 0.30, output: 1.20 }
it('按完整 usage 计费，思考是输出的子集，不重复收费', () => {
  expect(modelCost({ prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } }, rates)).toBeCloseTo(0.00007236, 10)
  expect(outputBreakdown({ completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } })).toEqual({ content: 10, reasoning: 40 })
})
it('预算并发预留包含修复，缺失 usage 后停止继续付费且保留未知费用预留', () => {
  const budget = new UsageBudget({ limitUsd: 0.002, prices: rates, maxInputTokens: 1000, maxOutputTokens: 1000 })
  const settle = budget.reserve()
  expect(() => budget.reserve()).toThrow(/预算/)
  settle({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 100 })
  expect(budget.snapshot().knownUsd).toBeCloseTo(0.00015)
  budget.reserve()(undefined)
  expect(budget.snapshot().unknownRequests).toBe(1)
  expect(() => budget.reserve()).toThrow(/未知/)
})
it('价格字段错拼、缺失和非有限值不能绕过预算', () => {
  for (const prices of [{ hit: .006, miss: .30, outputs: 1.20 }, { hit: .006, miss: .30 }, { hit: .006, miss: .30, output: NaN }]) {
    expect(() => new UsageBudget({ limitUsd: .001, prices: prices as any, maxInputTokens: 1000, maxOutputTokens: 1000 })).toThrow()
    expect(modelCost({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 100 }, prices as any)).toBeNull()
  }
})
it('有限价格相乘溢出时拒绝预算并报告费用未知', () => {
  const prices = { hit: Number.MAX_VALUE, miss: Number.MAX_VALUE, output: Number.MAX_VALUE }
  expect(modelCost({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 100, completion_tokens: 100 }, prices)).toBeNull()
  expect(() => new UsageBudget({ limitUsd: 1, prices, maxInputTokens: 1000, maxOutputTokens: 1000 }).reserve()).toThrow()
})
it('缺失或异常 usage 和未配置价格均报告未知费用，不当成零', () => {
  expect(modelCost(undefined, rates)).toBeNull()
  expect(modelCost({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 5 }, rates)).toBeNull()
  expect(modelCost({ prompt_tokens: 10, prompt_cache_hit_tokens: 11, completion_tokens: 1 }, rates)).toBeNull()
  expect(modelCost({ prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 5, completion_tokens: 1 })).toBeNull()
  expect(outputBreakdown({ completion_tokens: 10 })).toEqual({ content: null, reasoning: null })
})
it('每个付费 phase 在发送前验证实际请求的输入和输出预算契约', () => {
  const budget = new UsageBudget({ limitUsd: 1, prices: rates, maxInputTokens: 128, maxOutputTokens: 64 })
  expect(() => budget.reserve({ messages: [{ role: 'user', content: 'x' }] })).toThrow(/输出|output/)
  expect(() => budget.reserve({ messages: [{ role: 'user', content: 'x' }], max_tokens: 65 })).toThrow(/输出|output/)
  expect(() => budget.reserve({ messages: [{ role: 'user', content: 'x'.repeat(200) }], max_tokens: 64 })).toThrow(/输入|input/)
  expect(budget.snapshot().reservedUsd).toBe(0)
  budget.reserve({ messages: [{ role: 'user', content: 'x' }], max_tokens: 64 })({ prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, completion_tokens: 5 })
  expect(budget.snapshot().knownUsd).toBeGreaterThan(0)
})
