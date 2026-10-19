import { expect, it } from 'vitest'
import { outputTokenSpeed } from '../src/shared/core'

it('平均输出速度用远端输出 token 除以已采样请求总秒数，含思考 token 不重复相加', () => {
  const usage = { completionTokens: 1200, reasoningTokens: 800, completionElapsedMs: 4000 }
  expect(outputTokenSpeed(usage)).toBe(300)
  expect(outputTokenSpeed({ completionTokens: 0, completionElapsedMs: 1000 })).toBe(0)
})

it('尚无完整响应、旧记录缺少耗时或无效耗时应显示未知', () => {
  expect(outputTokenSpeed({ completionTokens: 0, completionElapsedMs: 0 })).toBeNull()
  expect(outputTokenSpeed({ completionTokens: 100 })).toBeNull()
  expect(outputTokenSpeed({ completionTokens: 100, completionElapsedMs: -1 })).toBeNull()
  expect(outputTokenSpeed({ completionTokens: NaN, completionElapsedMs: 100 })).toBeNull()
})
