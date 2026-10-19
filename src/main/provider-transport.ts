import { createHash } from 'node:crypto'
import { sanitizeLog } from '../shared/core'
import type { QuestionUsage, ServiceSettings } from '../shared/types'
import { measureUsage } from './cache-diagnostics'

type Priority = 'question' | 'translation'
interface Waiter { priority: Priority; signal: AbortSignal; resolve(release: () => void): void; reject(error: unknown): void; abort(): void }

// Two interactive admissions at most before a waiting translation gets a turn.
export class ProviderBudget {
  private queue: Waiter[] = []
  private active = 0
  private last = -Infinity
  private questionStreak = 0
  private timer?: ReturnType<typeof setTimeout>
  constructor(public qps: number, private concurrency = Math.min(8, Math.max(2, Math.ceil(qps * 2)))) {}
  acquire(priority: Priority, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { priority, signal, resolve, reject, abort: () => {
        this.queue = this.queue.filter(item => item !== waiter)
        signal.removeEventListener('abort', waiter.abort); reject(signal.reason); this.pump()
      } }
      signal.addEventListener('abort', waiter.abort, { once: true }); this.queue.push(waiter)
      if (signal.aborted) waiter.abort(); else this.pump()
    })
  }
  private pump() {
    clearTimeout(this.timer)
    if (!this.queue.length || this.active >= this.concurrency) return
    const wait = this.last + 1000 / this.qps - performance.now()
    if (wait > 0) { this.timer = setTimeout(() => this.pump(), Math.ceil(wait)); return }
    const translation = this.queue.findIndex(w => w.priority === 'translation')
    const question = this.queue.findIndex(w => w.priority === 'question')
    const index = question >= 0 && (translation < 0 || this.questionStreak < 2) ? question : Math.max(0, translation)
    const [waiter] = this.queue.splice(index, 1)
    waiter.signal.removeEventListener('abort', waiter.abort)
    this.questionStreak = waiter.priority === 'question' ? this.questionStreak + 1 : 0
    this.active++; this.last = performance.now()
    let released = false
    waiter.resolve(() => { if (!released) { released = true; this.active--; this.pump() } })
    this.pump()
  }
}
const budgets = new Map<string, ProviderBudget>()
function budgetFor(settings: ServiceSettings) {
  const key = createHash('sha256').update(`${settings.baseUrl.replace(/\/+$/, '')}\n${settings.apiKey}`).digest('hex')
  let budget = budgets.get(key)
  if (!budget) { budget = new ProviderBudget(settings.qps); budgets.set(key, budget) }
  budget.qps = settings.qps
  return budget
}
export async function openProviderResponse(settings: ServiceSettings, body: unknown, signal: AbortSignal, priority: Priority, onRequest?: () => void) {
  const release = await budgetFor(settings).acquire(priority, signal)
  try {
    signal.throwIfAborted(); onRequest?.()
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body), signal, redirect: 'error'
    })
    return { response, release }
  } catch (error) { release(); throw error }
}
export function usageFromProvider(raw: unknown, requested = true): QuestionUsage {
  const measured = measureUsage(raw)
  const reported = measured.promptTokens !== null && measured.completionTokens !== null && !measured.anomalies.length
  return { requests: requested ? 1 : 0, localCacheHits: 0, promptTokens: measured.promptTokens ?? 0, completionTokens: measured.completionTokens ?? 0,
    reasoningTokens: measured.reasoningTokens ?? 0, cachedPromptTokens: measured.comparable ? measured.hitTokens ?? 0 : 0,
    usageReported: reported, unknownRequests: requested && !reported ? 1 : 0 }
}
export function sumQuestionUsage(values: QuestionUsage[]): QuestionUsage {
  return values.reduce((sum, value) => ({
    requests: sum.requests + value.requests, localCacheHits: sum.localCacheHits + value.localCacheHits,
    promptTokens: sum.promptTokens + value.promptTokens, completionTokens: sum.completionTokens + value.completionTokens,
    reasoningTokens: sum.reasoningTokens + value.reasoningTokens, cachedPromptTokens: sum.cachedPromptTokens + value.cachedPromptTokens,
    usageReported: sum.usageReported || value.usageReported, unknownRequests: sum.unknownRequests + value.unknownRequests
  }), usageFromProvider(undefined, false))
}
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0; let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) { text += decoder.decode(); return text }
      size += chunk.value.byteLength
      if (size > 2_000_000) throw new Error('服务商响应过大，请检查服务地址。')
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function providerStream(settings: ServiceSettings, messages: { role: string; content: string }[], signal: AbortSignal, onDelta: (text: string) => void, onUsage?: (usage: QuestionUsage) => void) {
  // Question policy is independent of translation mode and its schema rewriting.
  const body: Record<string, unknown> = { model: settings.model, messages, stream: true, stream_options: { include_usage: true } }
  if (new URL(settings.baseUrl).hostname === 'api.deepseek.com') { body.thinking = { type: 'enabled' }; body.reasoning_effort = settings.reasoningEffort ?? 'high' }
  const { response, release } = await openProviderResponse(settings, body, signal, 'question', () => onUsage?.(usageFromProvider(undefined)))
  let usage = usageFromProvider(undefined); let finishReason: string | undefined
  let received = 0
  const consume = (data: any) => {
    if (data?.error) throw new Error('问答服务返回错误，请检查服务设置后重试。')
    if (data?.usage) { usage = usageFromProvider(data.usage); onUsage?.(usage) }
    const choice = data?.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const text = choice?.delta?.content ?? choice?.message?.content
    if (typeof text === 'string') { received += text.length; if (received > 100000) throw new Error('回答超出安全长度，请缩小问题后重试。'); onDelta(text) }
  }
  try {
    if (!response.ok) {
      const raw = await boundedText(response)
      let detail = ''
      try { const data = JSON.parse(raw); detail = typeof data?.error?.message === 'string' ? sanitizeLog(data.error.message, [settings.apiKey]).slice(0, 250) : '' } catch { /* Status is enough for HTML errors. */ }
      throw new Error(`HTTP ${response.status}：${response.status === 429 ? '问答服务限流或额度不足，请稍后手动重试。' : '问答请求失败，请检查服务地址、密钥和模型。'}${detail ? ` ${detail}` : ''}`)
    }
    if (response.headers.get('content-type')?.includes('application/json')) { consume(JSON.parse(await boundedText(response))) }
    else {
      if (!response.body) throw new Error('服务商没有返回回答流。')
      const reader = response.body.getReader(); const decoder = new TextDecoder()
      let pending = ''; let dataLines: string[] = []; let eventBytes = 0; let done = false
      const line = (value: string) => {
        if (value.endsWith('\r')) value = value.slice(0, -1)
        if (!value) {
          const data = dataLines.join('\n'); dataLines = []; eventBytes = 0
          if (!data) return
          if (data === '[DONE]') { done = true; return }
          let parsed: unknown
          try { parsed = JSON.parse(data) } catch { throw new Error('问答流格式损坏，已保留收到的部分回答。') }
          consume(parsed)
        } else if (value.startsWith('data:')) {
          eventBytes += Buffer.byteLength(value, 'utf8')
          if (eventBytes > 2_000_000) throw new Error('问答流事件过大。')
          dataLines.push(value.slice(5).trimStart())
        }
      }
      try {
        while (!done) {
          const chunk = await reader.read()
          pending += decoder.decode(chunk.value, { stream: !chunk.done })
          if (pending.length > 2_000_000) throw new Error('问答流事件过大。')
          let index: number
          while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index)); pending = pending.slice(index + 1); if (done) break }
          if (chunk.done) { if (pending) line(pending); line(''); break }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    signal.throwIfAborted()
    if (!received) throw new Error('服务商没有返回文字回答，请检查模型是否支持 Chat Completions。')
    if (!finishReason) throw new Error('回答流意外中断，已保留部分回答；可手动重试。')
    return { finishReason, usage }
  } finally { release() }
}
