import { measureUsage } from './cache-diagnostics'

// USD per million tokens. Prices are supplied by an experiment, never inferred from a model alias.
export interface TokenPrices { hit: number; miss: number; output: number }
const validPrices = (prices: TokenPrices | undefined): prices is TokenPrices => !!prices && Object.keys(prices).length === 3 && [prices.hit, prices.miss, prices.output].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
export function modelCost(raw: unknown, prices?: TokenPrices): number | null {
  const usage = measureUsage(raw)
  if (!validPrices(prices) || !usage.comparable || usage.completionTokens === null) return null
  const cost = (usage.hitTokens! * prices.hit + (usage.missTokens ?? usage.estimatedMissTokens!) * prices.miss + usage.completionTokens * prices.output) / 1_000_000
  return Number.isFinite(cost) ? cost : null
}
export function outputBreakdown(raw: unknown) {
  const usage = measureUsage(raw)
  return { content: usage.completionTokens !== null && usage.reasoningTokens !== null && !usage.anomalies.length ? usage.completionTokens - usage.reasoningTokens : null, reasoning: usage.reasoningTokens }
}

export class UsageBudget {
  private knownUsd = 0
  private reservedUsd = 0
  private unknownRequests = 0
  private stoppedReason: string | null = null
  constructor(readonly options: { limitUsd: number; prices: TokenPrices; maxInputTokens: number; maxOutputTokens: number; checkpoint?: (snapshot: ReturnType<UsageBudget['snapshot']>) => void }) {
    if (!Number.isFinite(options.limitUsd) || options.limitUsd <= 0 || !Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens <= 0 || !Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0 || !validPrices(options.prices)) throw new Error('实验预算或模型上限无效。')
  }
  reserve(request?: { messages: unknown[]; max_tokens?: number }) {
    if (request) {
      if (!Number.isSafeInteger(request.max_tokens) || request.max_tokens! < 1 || request.max_tokens! > this.options.maxOutputTokens) throw new Error('请求输出上限缺失或超过实验 output 预算契约。')
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.options.maxInputTokens) throw new Error('请求输入超过实验 input 预算契约。')
    }
    if (this.unknownRequests) throw new Error('已有未知费用请求，实验停止继续付费。')
    const upper = (this.options.maxInputTokens * Math.max(this.options.prices.hit, this.options.prices.miss) + this.options.maxOutputTokens * this.options.prices.output) / 1_000_000
    if (!Number.isFinite(upper) || this.knownUsd + this.reservedUsd + upper > this.options.limitUsd) {
      this.stoppedReason = 'insufficient-reservation'; throw new Error('实验预算不足以覆盖下次请求的保守预留。')
    }
    this.reservedUsd += upper
    this.options.checkpoint?.(this.snapshot())
    let settled = false
    return (raw: unknown) => {
      if (settled) return
      settled = true
      const cost = modelCost(raw, this.options.prices)
      if (cost === null) { this.unknownRequests++; this.stoppedReason = 'unknown-usage' }
      else {
        this.reservedUsd = Math.max(0, this.reservedUsd - upper); this.knownUsd += cost
        if (cost > upper) { this.unknownRequests++; this.stoppedReason = 'pricing-contract-exceeded' }
      }
      try { this.options.checkpoint?.(this.snapshot()) }
      catch { this.unknownRequests++; this.stoppedReason = 'budget-checkpoint-failed' }
    }
  }
  snapshot() { return { limitUsd: this.options.limitUsd, knownUsd: this.knownUsd, reservedUsd: this.reservedUsd, unknownRequests: this.unknownRequests, stoppedReason: this.stoppedReason } }
}
