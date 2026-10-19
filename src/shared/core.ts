import type { Position, ProviderSettings, ServiceSettings } from './types'
export interface PageMetric { top: number; height: number }
export function serverCacheHitRate(cache?: { samples: number; hitTokens: number; missTokens: number }): number | null {
  const total = (cache?.hitTokens ?? 0) + (cache?.missTokens ?? 0)
  return cache && cache.samples > 0 && total > 0 ? cache.hitTokens / total : null
}
export function outputTokenSpeed(usage: { completionTokens: number; completionElapsedMs?: number }): number | null {
  if (!Number.isFinite(usage.completionTokens) || usage.completionTokens < 0 || !Number.isFinite(usage.completionElapsedMs) || !usage.completionElapsedMs || usage.completionElapsedMs < 0) return null
  return usage.completionTokens / (usage.completionElapsedMs / 1000)
}
export function detectLanguage(text: string): 'en' | 'zh' | 'unknown' {
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const english = (text.match(/[a-zA-Z]/g) ?? []).length
  if (chinese >= 10 && chinese * 2 >= english) return 'zh'
  return english >= 10 ? 'en' : 'unknown'
}
export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim().replace(/\/chat\/completions\/?$/, ''))
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1'
  return url.toString().replace(/\/$/, '')
}
export function validateProvider(settings: ProviderSettings): ProviderSettings {
  if (!settings || typeof settings.baseUrl !== 'string' || typeof settings.apiKey !== 'string') throw new Error('请填写服务地址和 API 密钥。')
  let baseUrl: string
  try { baseUrl = normalizeBaseUrl(settings.baseUrl) } catch { throw new Error('服务地址不是有效的网址。') }
  const url = new URL(baseUrl)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('在线服务请使用 HTTPS 地址。')
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含账号、密码、查询参数或锚点。')
  if (!settings.apiKey.trim() || settings.apiKey.length > 4096 || /[\r\n]/.test(settings.apiKey)) throw new Error('请填写有效的 API 密钥。')
  return { baseUrl, apiKey: settings.apiKey.trim() }
}
export function validateSettings(settings: ServiceSettings): ServiceSettings {
  const provider = validateProvider(settings)
  if (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.length > 200) throw new Error('请选择模型，或填写服务商提供的 API 模型 ID。')
  if (!Number.isInteger(settings.qps) || settings.qps < 1 || settings.qps > 8) throw new Error('每秒请求数应为 1 到 8。')
  if (settings.reasoningEffort !== undefined && !['low', 'high', 'max'].includes(settings.reasoningEffort)) throw new Error('请选择轻度、标准或深度思考。')
  if (settings.translationMode !== undefined && !['economy', 'manual'].includes(settings.translationMode)) throw new Error('请选择有效的翻译策略。')
  return { ...provider, model: settings.model.trim(), qps: settings.qps, reasoningEffort: settings.reasoningEffort ?? 'high', translationMode: settings.translationMode ?? 'manual' }
}
export function cacheKey(hash: string, settings: ServiceSettings, engine: string): string {
  const mode = settings.translationMode === 'economy' ? 'reader-economy-v1' : !settings.reasoningEffort || settings.reasoningEffort === 'high' ? 'reader-v1' : `reader-${settings.reasoningEffort}-v1`
  return JSON.stringify([hash, normalizeBaseUrl(settings.baseUrl), settings.model.trim(), 'en', 'zh', engine, mode])
}
export function sanitizeLog(value: string, secrets: string[]): string {
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[已隐藏]')
  return text.replace(/(Bearer\s+)[\w.\-/+=]+/gi, '$1[已隐藏]').replace(/((?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[已隐藏]').slice(0, 1200)
}
export function parseProgress(line: string): { stage: string; percent: number | null } {
  const match = line.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/)
  let stage = '正在处理论文'
  if (/warmup|asset|font/i.test(line)) stage = '正在准备字体与模型'
  if (/parse|layout|detect|extract.*pdf/i.test(line)) stage = '正在解析论文版式'
  if (/glossary|term.*extract/i.test(line)) stage = '正在提取学术术语'
  if (/translat.*paragraph|paragraph.*translat|translateparagraph/i.test(line)) stage = '正在翻译正文'
  if (/typeset|render|generat.*pdf|save.*pdf/i.test(line)) stage = '正在生成中文 PDF'
  return { stage, percent: match ? Math.min(100, Number(match[1])) : null }
}
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min))
export function positionFromScroll(top: number, pages: PageMetric[]): Position {
  if (!pages.length) return { page: 1, fraction: 0 }
  let low = 0; let high = pages.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (pages[middle].top <= top + 1) low = middle
    else high = middle - 1
  }
  const index = low
  const metric = pages[index]
  return { page: index + 1, fraction: clamp((top - metric.top) / Math.max(1, metric.height), 0, 1) }
}
export function scrollFromPosition(position: Position, pages: PageMetric[]): number {
  if (!pages.length) return 0
  const metric = pages[Math.floor(clamp(position.page, 1, pages.length)) - 1]
  return metric.top + metric.height * clamp(position.fraction, 0, 1)
}
