import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServiceSettings, TranslationUsage } from '../shared/types'
import { writeJson } from './store'
import { batchInputStart, canonicalJson, stableMessages, type Message } from './translation-prompts'
import { CacheDiagnostics, describePrefix, fingerprint, measureUsage, type RequestPhase } from './cache-diagnostics'
import { CacheScheduler, type ColdStartOptions } from './cache-scheduler'
import { ParagraphCache, paragraphKey, parseBatch, validParagraph, validatedParagraphs, type ParagraphResult } from './paragraph-cache'
import { EXTRACTION_VERSION, TRANSLATION_POLICY_VERSION } from './cache-versions'
import { qualityParagraph } from './translation-quality'
import { TranslationAudit, type TranslationQualityOptions } from './translation-audit'
import { SEMANTIC_REVIEW_RULES, parseSemanticReview } from './translation-review'
import { openProviderResponse } from './provider-transport'
import { clearDefinitionTerms, semanticRisks, strategyVersion, type TranslationStrategy } from './translation-strategy'
import { DocumentTerminology, uniqueTerms } from './document-terminology'
import type { TokenPrices, UsageBudget } from './translation-cost'

export interface ChatRequest { model?: string; messages: Message[]; stream?: boolean; max_tokens?: number; [key: string]: unknown }
export interface ChatResponse { choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: Record<string, any>; [key: string]: unknown }
export interface Reply { status: number; body: ChatResponse; headers?: Record<string, string>; validatedOutputs?: Map<string | number, string> }

// Only the known batch template is reorganized. All contextual text stays in the user message.
function legacyMessages(messages: Message[]): Message[] {
  if (messages.length !== 1 || messages[0].role !== 'user' || typeof messages[0].content !== 'string') return messages
  const text = messages[0].content
  if (!text.startsWith('You are a professional ') || !text.includes('\n## Structure Rules\n') || !text.includes('\n## Here is the input:')) return messages
  const positions = ['\n## Contextual Hints for Better Translation', '\n## Glossary Tables', '\n## Here is the input:'].map(marker => text.indexOf(marker)).filter(index => index >= 0)
  const boundary = Math.min(...positions)
  let prefix = text.slice(0, boundary)
  const glossary = prefix.match(/\n## Glossary\n[\s\S]*?(?=\n## Output Format)/)?.[0] ?? ''
  if (glossary) prefix = prefix.replace(glossary, '\n')
  prefix = prefix.replace(/\n{3,}/g, '\n\n').trim()
  return [{ role: 'system', content: prefix }, { role: 'user', content: `${glossary.trim()}\n\n${text.slice(boundary).trim()}`.trim() }]
}

export function prepareTranslationRequest(input: ChatRequest, settings: ServiceSettings, strategy: TranslationStrategy = 'baseline'): ChatRequest {
  const body: ChatRequest = { ...input, model: settings.model, messages: stableMessages(input.messages, strategy !== 'baseline') }
  if (new URL(settings.baseUrl).hostname === 'api.deepseek.com') {
    body.thinking = { type: 'enabled' }
    body.reasoning_effort = settings.translationMode === 'economy' && describePrefix(body).type !== 'unknown' ? 'low' : settings.reasoningEffort ?? 'high'
    if (strategy === 'adaptive' && settings.translationMode === 'economy' && ['deepseek-flash', 'deepseek-v4-pro'].includes(settings.model) && describePrefix(body).type === 'terminology' && clearDefinitionTerms(body)) {
      body.thinking = { type: 'disabled' }; delete body.reasoning_effort
    }
  }
  return body
}

function successful(body: ChatResponse, request: ChatRequest, validate: (source: string, output: unknown) => boolean = validParagraph): boolean {
  const content = body.choices?.[0]?.message?.content
  if (body.choices?.length !== 1 || body.choices[0].finish_reason !== 'stop' || typeof content !== 'string' || !content.trim()) return false
  if (request.messages[0]?.role === 'system' && request.messages[0].content === SEMANTIC_REVIEW_RULES) {
    try {
      const paragraphs = JSON.parse(request.messages[1].content).paragraphs
      return Array.isArray(paragraphs) && parseSemanticReview(content, paragraphs) !== null
    } catch { return false }
  }
  const type = describePrefix(request).type
  const input = type === 'batch' ? request.messages.find(message => message.role === 'user' && message.content.includes('## Here is the input:'))?.content : undefined
  if (input) {
    try {
      const paragraphs = JSON.parse(input.slice(batchInputStart(input) + '## Here is the input:'.length).trim()) as { id: unknown; input?: string }[]
      const output = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').replace(/^<json>\s*|\s*<\/json>$/g, '')) as { id: unknown; output: unknown }[]
      if (!Array.isArray(paragraphs) || !Array.isArray(output) || output.length !== paragraphs.length) return false
      const ids = new Set(output.map(item => item?.id))
      return ids.size === paragraphs.length && paragraphs.every(item => ids.has(item.id)) && output.every(item => validate(paragraphs.find(source => source.id === item.id)?.input ?? '', item.output))
    } catch { return false }
  }
  if (type === 'terminology') {
    try {
      const terms = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
      return Array.isArray(terms) && terms.every(term => term && typeof term.src === 'string' && term.src.trim() && typeof term.tgt === 'string' && term.tgt.trim() && validate(term.src, term.tgt))
    } catch { return false }
  }
  if (type === 'single') {
    const user = request.messages[1]?.content ?? ''
    const marker = 'Now translate the following text:'
    return validate(user.includes(marker) ? user.slice(user.indexOf(marker) + marker.length).trim() : user, content)
  }
  return true
}
function reused(reply: Reply): Reply {
  const { usage: _usage, ...body } = reply.body
  return { ...reply, body: { ...body, reader_local_cache_hit: true } }
}

export async function startTranslationGateway(options: { settings: ServiceSettings; cacheDir: string; signal?: AbortSignal; onUsage?: (usage: TranslationUsage) => void; onParagraph?: (paragraph: { id: string | number; input: string; output: string }) => void | Promise<void>; onProviderFailure?: (failure: { phase: RequestPhase; status: number | null }) => void; taskId?: string; diagnosticsDir?: string; coldStart?: ColdStartOptions; documentFingerprint?: string; translationPolicyVersion?: string; strategy?: TranslationStrategy; extractionVersion?: string; prices?: TokenPrices; budget?: UsageBudget; quality?: TranslationQualityOptions }) {
  const strategy = options.strategy ?? 'baseline'
  const extractionVersion = options.extractionVersion ?? EXTRACTION_VERSION
  const diagnostics = new CacheDiagnostics({ directory: options.diagnosticsDir ?? join(options.cacheDir, 'diagnostics'), taskId: options.taskId, service: options.settings.baseUrl, secrets: [options.settings.apiKey], prices: options.prices, experiment: { strategy, extractionVersion, documentFingerprint: options.documentFingerprint, translationPolicyVersion: options.translationPolicyVersion ?? TRANSLATION_POLICY_VERSION } })
  const stats = diagnostics.stats
  const economy = options.settings.translationMode === 'economy' && new URL(options.settings.baseUrl).hostname === 'api.deepseek.com'
  const validate = qualityParagraph
  const isSuccessful = (body: ChatResponse, request: ChatRequest) => successful(body, request, validate)
  const scheduler = new CacheScheduler(options.coldStart, options.settings.qps, economy)
  const paragraphs = new ParagraphCache(join(options.cacheDir, economy ? 'paragraph-economy-v1' : 'paragraph-v2'), validate)
  const policy = `${options.translationPolicyVersion ?? TRANSLATION_POLICY_VERSION}${economy ? ':economy-quality-v1' : ''}${strategyVersion(strategy)}:extraction-${extractionVersion}`
  const audit = options.quality ? new TranslationAudit({ ...options.quality, reviewer: fingerprint([options.settings.baseUrl, options.settings.model, 'high']), documentId: options.documentFingerprint ?? 'unscoped', policy }) : null
  const repairsEnabled = economy || !!audit
  const terminology = strategy !== 'baseline' && options.documentFingerprint ? new DocumentTerminology(join(options.cacheDir, 'document-terminology-v1'), { document: options.documentFingerprint, service: options.settings.baseUrl, model: options.settings.model, policy: `${policy}:${options.settings.reasoningEffort ?? 'high'}`, extraction: extractionVersion }) : null
  stats.paragraphs = { total: 0, reused: 0 }
  const token: string = randomUUID()
  const pending = new Map<string, Promise<Reply>>()
  const attempts = new Map<string, number>()
  const qualityFailures = new Map<string, Reply>()
  let inFlight = 0
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const publish = () => options.onUsage?.(structuredClone(stats))
  const notifyParagraphs = async (body: ChatRequest, value: Reply) => {
    if (!options.onParagraph || value.status < 200 || value.status >= 300) return
    const batch = parseBatch(body)
    if (!batch) return
    for (const [id, output] of validatedParagraphs(value.body, batch.paragraphs, validate)) {
      await options.onParagraph({ id, input: batch.paragraphs.find(paragraph => paragraph.id === id)!.input, output })
    }
  }
  const reviewSource = (source: string) => !audit && strategy === 'adaptive' && economy && (semanticRisks(source).length > 0 || parseInt(fingerprint([options.documentFingerprint, source]).slice(0, 8), 16) % 20 === 0)
  const highRequest = (body: ChatRequest): ChatRequest => prepareTranslationRequest(body, { ...options.settings, translationMode: 'manual', reasoningEffort: 'high' }, 'baseline')
  const request = async (body: ChatRequest, file: string | undefined, key: string, requestId: string, phase: RequestPhase = 'primary'): Promise<Reply> => {
    const prefix = describePrefix(body)
    const lease = await scheduler.acquire(fingerprint([options.settings.baseUrl, body.model, body.thinking, body.reasoning_effort, prefix.type, prefix.fixedPrefixFingerprint]), prefix.fixedPrefixBytes, signal, prefix.type !== 'unknown')
    if (signal.aborted) { lease.complete(); signal.throwIfAborted() }
    let settleBudget: ((usage: unknown) => void) | undefined
    try { settleBudget = options.budget?.reserve(body) } catch (error) { lease.complete(); throw error }
    stats.requests++; publish()
    const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt)
    const concurrency = ++inFlight
    const started = performance.now()
    const prefixObservation = diagnostics.begin(body)
    let status: number | undefined; let data: ChatResponse | undefined; let outcome: 'completed' | 'error' | 'cancelled' = 'error'
    let elapsedMs: number | undefined
    try {
    const transport = await openProviderResponse(options.settings, body, AbortSignal.any([signal, AbortSignal.timeout(600000)]), 'translation')
    const upstream = transport.response
    status = upstream.status
    let raw: string
    try { raw = await upstream.text() } finally { transport.release() }
    elapsedMs = performance.now() - started
    const headers: Record<string, string> = {}
    for (const name of ['retry-after', 'retry-after-ms']) { const value = upstream.headers.get(name); if (value) headers[name] = value }
    try { data = JSON.parse(upstream.ok ? raw : raw.split(options.settings.apiKey).join('[已隐藏]')) }
    catch { return { status: upstream.ok ? 502 : upstream.status, headers, body: { error: { message: `服务商返回了非 JSON 响应（HTTP ${upstream.status}）。` } } } }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 502, body: { error: { message: '服务商返回了无效响应。' } } }
    await notifyParagraphs(body, { status: upstream.status, body: data })
    if (upstream.ok && isSuccessful(data, body)) {
      outcome = 'completed'
      // An unavailable cache must not turn a valid translation into a failed API request.
      if (file) await writeJson(file, { version: 1, body: data }).catch(() => {})
    }
    return { status: upstream.status, body: data, headers }
    } finally {
      inFlight--
      const measured = measureUsage(data?.usage)
      settleBudget?.(data?.usage)
      lease.complete(measured.comparable && (measured.hitTokens ?? 0) > 0)
      if (signal.aborted) outcome = 'cancelled'
      diagnostics.record({ source: 'remote', outcome, requestId, logicalFingerprint: key, attempt, body, status, usage: data?.usage, actualModel: data?.model, elapsedMs: elapsedMs ?? performance.now() - started, inFlight: concurrency, schedulerWaitMs: lease.waitMs, prefixObservation, phase })
      if (status === undefined || status < 200 || status >= 300) options.onProviderFailure?.({ phase, status: status ?? null })
      publish()
    }
  }
  const qualityFailure: Reply = { status: 422, body: { error: { code: 'translation-structure-failure', message: '译文校验未通过，重点复译后仍存在缺段、数值或公式问题。本任务已停止重复付费重试，请检查原文或改用手动标准思考后重试。' } } }
  const checkedRequest = async (body: ChatRequest, file: string, key: string, requestId: string): Promise<Reply> => {
    if (qualityFailures.has(key)) return qualityFailures.get(key)!
    let result = await request(body, economy && describePrefix(body).type !== 'unknown' ? undefined : file, key, requestId)
    if (!repairsEnabled || result.status < 200 || result.status >= 300 || describePrefix(body).type === 'unknown') return result
    const valid = isSuccessful(result.body, body)
    const review = describePrefix(body).type !== 'terminology' && body.messages.some(message => message.role === 'user' && reviewSource(message.content))
    if (valid && !review) { await writeJson(file, { version: 1, body: result.body }).catch(() => {}); return result }
    signal.throwIfAborted()
    if (valid) stats.semanticReviewRequests = (stats.semanticReviewRequests ?? 0) + 1
    else stats.qualityRepairRequests = (stats.qualityRepairRequests ?? 0) + 1
    publish()
    try { result = await request(highRequest(body), undefined, key, requestId, valid ? 'semantic-review' : 'repair') }
    catch { qualityFailures.set(key, repairInterrupted); return repairInterrupted }
    if (result.status < 200 || result.status >= 300) { qualityFailures.set(key, result); return result }
    if (!isSuccessful(result.body, body)) { qualityFailures.set(key, qualityFailure); return qualityFailure }
    qualityFailures.delete(key)
    await writeJson(file, { version: 1, body: result.body }).catch(() => {})
    return result
  }
  const repairInterrupted: Reply = { status: 502, body: { error: { message: '重点复译连接中断，无法确认本次费用和结果。本任务不再重复付费尝试；已通过的段落已保存，请稍后重新启动翻译。' } } }
  const translateTerms = async (body: ChatRequest, file: string, key: string, requestId: string): Promise<Reply> => {
    const plan = await terminology?.plan(body)
    if (!plan) return checkedRequest(body, file, key, requestId)
    let remote: Reply | undefined
    let terms = plan.reusedTerms
    if (!plan.complete) {
      remote = await checkedRequest(plan.body, `${file}.terms`, key, requestId)
      if (remote.status < 200 || remote.status >= 300 || !isSuccessful(remote.body, plan.body)) return remote
      const extracted = JSON.parse(remote.body.choices![0].message!.content!.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
      await terminology!.commit(plan, extracted).catch(() => {})
      terms = uniqueTerms([...terms, ...extracted])
    }
    const localSections = plan.reusedSections
    stats.localTermSectionHits = (stats.localTermSectionHits ?? 0) + localSections
    if (plan.complete) stats.localCacheHits++
    const result: Reply = { status: 200, body: { ...(remote?.body ?? {}), choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(terms) } }] } }
    await writeJson(file, { version: 1, body: result.body }).catch(() => {})
    publish()
    return plan.complete ? reused(result) : result
  }
  const translate = async (body: ChatRequest, file: string, key: string, requestId: string): Promise<Reply> => {
    if (terminology && describePrefix(body).type === 'terminology') return translateTerms(body, file, key, requestId)
    const batch = options.documentFingerprint ? parseBatch(body) : null
    if (!batch) return checkedRequest(body, file, key, requestId)
    const keys = batch.paragraphs.map(paragraph => paragraphKey(body, paragraph, { service: options.settings.baseUrl, document: options.documentFingerprint!, effort: options.settings.reasoningEffort ?? 'high', policy }, batch))
    const cached = await Promise.all(keys.map((key, index) => paragraphs.read(key, batch.paragraphs[index].input)))
    if (options.onParagraph) for (let index = 0; index < cached.length; index++) {
      if (cached[index] !== undefined) await options.onParagraph({ ...batch.paragraphs[index], output: cached[index]! })
    }
    signal.throwIfAborted()
    const previousFailure = repairsEnabled && keys.map(key => qualityFailures.get(key)).find(Boolean)
    if (previousFailure) return previousFailure
    // Claim every key synchronously after disk reads, so intersecting batches cannot form a wait cycle.
    const claims = new Map<string, ReturnType<ParagraphCache['claim']>>()
    const owned: number[] = []
    let localHits = 0; let waits = 0
    for (let index = 0; index < keys.length; index++) {
      if (cached[index] !== undefined) { localHits++; continue }
      if (claims.has(keys[index])) { localHits++; continue }
      const claim = paragraphs.claim(keys[index]); claims.set(keys[index], claim)
      if (claim.owned) owned.push(index)
      else { localHits++; waits++ }
    }
    stats.inflightWaits! += waits
    let remote: Reply | undefined
    if (owned.length) {
      try {
        const missing = owned.map(index => batch.paragraphs[index])
        remote = await request(batch.withParagraphs(missing), undefined, key, requestId)
        const valid = remote.status >= 200 && remote.status < 300 ? validatedParagraphs(remote.body, missing, validate) : new Map<string | number, string>()
        const invalid = missing.filter(paragraph => !valid.has(paragraph.id))
        const review = missing.filter(paragraph => valid.has(paragraph.id) && reviewSource(paragraph.input))
        if (repairsEnabled && remote.status >= 200 && remote.status < 300 && (invalid.length || review.length)) {
          const targets = missing.filter(paragraph => invalid.includes(paragraph) || review.includes(paragraph))
          for (const paragraph of review) valid.delete(paragraph.id)
          // Preserve successful siblings before a repair can fail or be cancelled.
          for (const index of owned) {
            const output = valid.get(batch.paragraphs[index].id)
            if (output !== undefined) { await paragraphs.write(keys[index], output); claims.get(keys[index])!.settle({ output }) }
          }
          signal.throwIfAborted()
          if (invalid.length) stats.qualityRepairRequests = (stats.qualityRepairRequests ?? 0) + 1
          if (review.length) stats.semanticReviewRequests = (stats.semanticReviewRequests ?? 0) + 1
          publish()
          let repair: Reply
          try { repair = await request(highRequest(batch.withParagraphs(targets)), undefined, key, requestId, invalid.length ? 'repair' : 'semantic-review') }
          catch { repair = repairInterrupted }
          if (repair.status >= 200 && repair.status < 300) {
            for (const [id, output] of validatedParagraphs(repair.body, targets, validate)) {
              valid.set(id, output)
              const index = batch.paragraphs.findIndex(paragraph => paragraph.id === id)
              qualityFailures.delete(keys[index])
            }
            for (const index of owned) if (!valid.has(batch.paragraphs[index].id)) qualityFailures.set(keys[index], qualityFailure)
          }
          else for (const index of owned) if (!valid.has(batch.paragraphs[index].id)) qualityFailures.set(keys[index], repair)
          remote = repair
        }
        const failure: Reply = remote.status >= 200 && remote.status < 300 ? repairsEnabled ? qualityFailure : { status: 502, body: { error: { code: 'translation-structure-failure', message: '翻译回复存在缺段、重复 ID、空译文或损坏的公式/样式占位符，请重试。' } } } : remote
        for (const index of owned) {
          const output = valid.get(batch.paragraphs[index].id)
          if (output !== undefined) { await paragraphs.write(keys[index], output); claims.get(keys[index])!.settle({ output }) }
          else claims.get(keys[index])!.settle({ failure })
        }
      } catch (error) { for (const index of owned) claims.get(keys[index])!.settle({ error }); throw error }
    }
    const results: ParagraphResult[] = await Promise.all(keys.map((key, index) => cached[index] !== undefined ? { output: cached[index]! } : claims.get(key)!.promise))
    const failure = results.find(result => 'failure' in result || 'error' in result)
    if (failure && 'failure' in failure) return { ...failure.failure, validatedOutputs: new Map(batch.paragraphs.flatMap((paragraph, index) => 'output' in results[index] ? [[paragraph.id, (results[index] as { output: string }).output] as const] : [])) }
    if (failure && 'error' in failure) throw failure.error
    stats.localParagraphHits! += localHits
    stats.paragraphs!.reused += localHits
    if (localHits) {
      diagnostics.record({ source: 'paragraph-cache', outcome: 'completed', requestId, logicalFingerprint: key, attempt: 0, body, elapsedMs: 0, inFlight, waited: waits > 0 })
      publish()
    }
    const content = JSON.stringify(batch.paragraphs.map((paragraph, index) => ({ id: paragraph.id, output: (results[index] as { output: string }).output })))
    let result: Reply = { status: 200, body: { ...(remote?.body ?? {}), choices: [{ finish_reason: 'stop', message: { content } }] } }
    if (!owned.length) { stats.localCacheHits++; publish(); result = reused(result) }
    await writeJson(file, { version: 1, body: result.body }).catch(() => {})
    return result
  }
  const auditedReply = async (body: ChatRequest, value: Reply, key: string, requestId: string): Promise<Reply> => {
    await notifyParagraphs(body, value)
    if (audit) await audit.observe(body, value, async review => {
      signal.throwIfAborted()
      stats.semanticReviewRequests = (stats.semanticReviewRequests ?? 0) + 1; publish()
      const prepared = prepareTranslationRequest({ ...review, ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }) }, { ...options.settings, translationMode: 'manual', reasoningEffort: 'high' }, 'baseline')
      const result = await request(prepared, undefined, `${key}:independent-review`, requestId, 'semantic-review')
      if (result.status < 200 || result.status >= 300 || result.body.choices?.length !== 1 || result.body.choices[0].finish_reason !== 'stop') throw new Error('Independent review incomplete')
      return result.body.choices[0].message?.content ?? ''
    })
    return value
  }
  const server = createServer(async (req, res) => {
    const reply = (value: Reply) => { res.writeHead(value.status, { 'Content-Type': 'application/json', ...value.headers }); res.end(JSON.stringify(value.body)) }
    try {
      if (req.headers.authorization !== `Bearer ${token}`) { reply({ status: 401, body: { error: { message: '本地翻译通道鉴权失败。' } } }); return }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { reply({ status: 404, body: { error: { message: '未知的本地翻译接口。' } } }); return }
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of req) {
        size += chunk.length
        if (size > 4 * 1024 * 1024) { reply({ status: 413, body: { error: { message: '翻译批次过大。' } } }); return }
        chunks.push(chunk)
      }
      let input: ChatRequest
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { reply({ status: 400, body: { error: { message: '翻译请求不是有效 JSON。' } } }); return }
      if (!input || input.stream || !Array.isArray(input.messages) || !input.messages.length || input.messages.some(message => !message || typeof message.content !== 'string' || typeof message.role !== 'string')) {
        reply({ status: 400, body: { error: { message: '翻译请求缺少有效消息。' } } }); return
      }
      const body = prepareTranslationRequest(input, options.settings, strategy)
      const logicalParagraphs = parseBatch(body)?.paragraphs.length ?? 0
      stats.paragraphs!.total += logicalParagraphs
      const requestId = randomUUID()
      const key = createHash('sha256').update(canonicalJson(options.documentFingerprint ? [options.settings.baseUrl, body, options.documentFingerprint, options.settings.reasoningEffort ?? 'high', policy, 'reader-api-scoped-v1'] : [options.settings.baseUrl, body, economy ? policy : 'reader-api-v2'])).digest('hex')
      const file = join(options.cacheDir, `${key}.json`)
      const legacyKey = createHash('sha256').update(JSON.stringify([options.settings.baseUrl, { ...body, messages: legacyMessages(input.messages) }, 'reader-api-v1'])).digest('hex')
      // A changed translation policy must not revive translations made without it.
      const candidates = !economy && !options.documentFingerprint && body.messages === input.messages ? [file, join(options.cacheDir, `${legacyKey}.json`)] : [file]
      for (const candidate of candidates) {
        let cached: { version?: number; body?: ChatResponse }
        try { cached = JSON.parse(await readFile(candidate, 'utf8')) }
        catch { continue /* A missing or damaged entry is a cache miss. */ }
        if (cached?.version === 1 && cached.body && isSuccessful(cached.body, body)) {
          stats.paragraphs!.reused += logicalParagraphs
          stats.localCacheHits++
          diagnostics.record({ source: 'request-cache', outcome: 'completed', requestId, logicalFingerprint: key, attempt: 0, body, elapsedMs: 0, inFlight })
          publish(); reply(await auditedReply(body, reused({ status: 200, body: cached.body }), key, requestId)); return
        }
      }
      const existing = pending.get(key)
      if (existing) {
        stats.inflightWaits!++
        const result = await existing
        if (result.status >= 200 && result.status < 300 && isSuccessful(result.body, body)) {
          stats.paragraphs!.reused += logicalParagraphs
          stats.localCacheHits++
          diagnostics.record({ source: 'request-inflight', outcome: 'completed', requestId, logicalFingerprint: key, attempt: 0, body, elapsedMs: 0, inFlight, waited: true })
          publish(); reply(await auditedReply(body, reused(result), key, requestId))
        }
        else reply(await auditedReply(body, result, key, requestId))
        return
      }
      const operation = translate(body, file, key, requestId).then(result => auditedReply(body, result, key, requestId))
      pending.set(key, operation)
      try { reply(await operation) } finally { pending.delete(key) }
    } catch { if (!res.headersSent) reply({ status: 502, body: { error: { message: signal.aborted ? '翻译已停止。' : '翻译服务连接失败或请求超时。' } } }) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法建立本地翻译通道。')
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, token, stats, diagnosticsFile: diagnostics.file, diagnosticsSummaryFile: diagnostics.summaryFile,
    qualityReportFile: audit?.review.file, glossaryFile: audit?.glossary.file,
    async flushQuality(extra: Record<string, unknown> = {}) { await audit?.flush(extra) },
    async close() {
      if (closed) return
      closed = true; controller.abort(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.allSettled([...pending.values()])
      try { await audit?.flush() } finally { await diagnostics.flush(); publish() }
    }
  }
}
