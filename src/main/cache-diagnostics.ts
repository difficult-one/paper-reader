import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranslationUsage } from '../shared/types'
import { batchInputStart, canonicalJson, type Message } from './translation-prompts'
import { writeJson } from './store'
import { modelCost, outputBreakdown, type TokenPrices } from './translation-cost'

export const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
export type RequestType = 'batch' | 'terminology' | 'single' | 'unknown'
export interface DiagnosticRequest { model?: string; messages: Message[]; [key: string]: unknown }
const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function measureUsage(value: unknown) {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  const fields = [raw.prompt_tokens, raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens, raw.prompt_cache_miss_tokens, raw.completion_tokens, raw.completion_tokens_details?.reasoning_tokens]
  const [promptTokens, hitTokens, missTokens, completionTokens, reasoningTokens] = fields.map(field => tokenCount(field) ? field : null)
  const rawValue = (field: unknown) => field == null ? null : typeof field === 'number' && Number.isFinite(field) ? field : { invalidType: typeof field }
  const rawFields = { prompt_tokens: rawValue(raw.prompt_tokens), prompt_cache_hit_tokens: rawValue(raw.prompt_cache_hit_tokens), prompt_cache_miss_tokens: rawValue(raw.prompt_cache_miss_tokens), cached_tokens: rawValue(raw.prompt_tokens_details?.cached_tokens), completion_tokens: rawValue(raw.completion_tokens), reasoning_tokens: rawValue(raw.completion_tokens_details?.reasoning_tokens) }
  const anomalies: string[] = []
  if (fields.some(field => field !== undefined && field !== null && !tokenCount(field))) anomalies.push('invalid-token-count')
  if (tokenCount(raw.prompt_cache_hit_tokens) && tokenCount(raw.prompt_tokens_details?.cached_tokens) && raw.prompt_cache_hit_tokens !== raw.prompt_tokens_details.cached_tokens) anomalies.push('conflicting-hit-fields')
  if (promptTokens !== null && hitTokens !== null && hitTokens > promptTokens) anomalies.push('hit-exceeds-input')
  if (promptTokens !== null && hitTokens !== null && missTokens !== null && hitTokens + missTokens !== promptTokens) anomalies.push('input-not-hit-plus-miss')
  if (completionTokens !== null && reasoningTokens !== null && reasoningTokens > completionTokens) anomalies.push('reasoning-exceeds-output')
  const estimatedMissTokens = missTokens === null && raw.prompt_cache_miss_tokens == null && promptTokens !== null && hitTokens !== null && hitTokens <= promptTokens ? promptTokens - hitTokens : null
  const comparable = anomalies.length === 0 && hitTokens !== null && (missTokens !== null || estimatedMissTokens !== null)
  return { raw: rawFields, promptTokens, hitTokens, missTokens, completionTokens, reasoningTokens, estimatedMissTokens, comparable, anomalies,
    source: raw.prompt_cache_hit_tokens != null ? 'provider-cache-fields' : raw.prompt_tokens_details?.cached_tokens != null ? 'provider-token-details' : Object.keys(raw).length ? 'provider-without-cache' : 'missing' }
}

export function describePrefix(body: DiagnosticRequest) {
  const system = body.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
  const template = system.replace(/\r\n/g, '\n')
  const user = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
  const type: RequestType = template.trimStart().startsWith('You are an expert multilingual terminologist.') ? 'terminology'
    : template.startsWith('You are a professional ') && template.includes('\n## Structure Rules\n') && user.includes('## Here is the input:') ? 'batch'
    : template.startsWith('You are a professional ') && template.includes('\n## Rules\n') || template.startsWith('You are a professional,authentic machine translation engine.') ? 'single' : 'unknown'
  const markers = type === 'batch' ? ['## Glossary', '## Original batch source context', '## Here is the input:'] : type === 'terminology' ? ['Reference Glossaries (for consistency and quality):', 'Input Text:\n```'] : ['## Glossary', 'Now translate the following text:']
  const boundary = Math.min(user.length, ...markers.map(marker => user.indexOf(marker)).filter(index => index >= 0))
  const context = type === 'unknown' ? '' : user.slice(0, boundary)
  const glossaryStart = user.search(/^(?:## Glossary|Reference Glossaries \(for consistency and quality\):)/m)
  const inputStart = type === 'batch' ? batchInputStart(user) : user.indexOf(type === 'terminology' ? 'Input Text:\n```' : 'Now translate the following text:')
  const glossary = glossaryStart >= 0 ? user.slice(glossaryStart, inputStart > glossaryStart ? inputStart : undefined) : ''
  const fixed = canonicalJson([body.messages.filter(message => message.role === 'system'), context])
  return { type, templateVersion: 'reader-prefix-v2', ruleFingerprint: fingerprint(system), contextFingerprint: fingerprint(context), glossaryFingerprint: fingerprint(glossary), fixedPrefixFingerprint: fingerprint(fixed), fixedPrefixBytes: Buffer.byteLength(fixed), fixed }
}

export function initialUsage(): TranslationUsage {
  return { requests: 0, localCacheHits: 0, localParagraphHits: 0, inflightWaits: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    usageReported: false, cacheUsageReported: false, reasoningUsageReported: false, completionElapsedMs: 0,
    cache: { samples: 0, estimatedSamples: 0, missingSamples: 0, anomalousSamples: 0, hitTokens: 0, missTokens: 0, rawMissTokens: 0, diagnosticWriteFailures: 0, fieldSamples: { prompt: 0, hit: 0, miss: 0, completion: 0, reasoning: 0 } } }
}
export type DiagnosticSource = 'remote' | 'request-cache' | 'request-inflight' | 'paragraph-cache'
export type RequestPhase = 'primary' | 'repair' | 'semantic-review'
interface Observation { source: DiagnosticSource; outcome: 'completed' | 'error' | 'cancelled'; requestId: string; logicalFingerprint: string; attempt: number; body: DiagnosticRequest; elapsedMs: number; inFlight: number; status?: number; usage?: unknown; actualModel?: unknown; waited?: boolean; schedulerWaitMs?: number; prefixObservation?: ReturnType<CacheDiagnostics['begin']>; phase?: RequestPhase }
interface GroupSummary { remoteAttempts: number; samples: number; hitTokens: number; missTokens: number; coldAttempts: number; prefixChanges: number; warmSamples: number; warmHitTokens: number; warmMissTokens: number; completed: number; errors: number; cancelled: number; usageMissing: number; schedulerWaitMs: number; completionTokens: number; reasoningTokens: number; contentTokens: number; unknownContentRequests: number; knownModelUsd: number; unknownCostRequests: number }

// Payloads are deliberately constructed from an allowlist. No prompt, response, URL or error text reaches disk.
export class CacheDiagnostics {
  readonly file: string
  readonly summaryFile: string
  private writes: Promise<unknown> = Promise.resolve()
  private previous = new Map<string, { shape: string; rule: string; context: string; glossary: string }>()
  private seenPrefixes = new Set<string>()
  private groups: Partial<Record<RequestType, GroupSummary>> = {}
  private phases: Partial<Record<RequestPhase, { remoteAttempts: number; completionTokens: number; contentTokens: number; reasoningTokens: number; knownModelUsd: number; unknownCostRequests: number }>> = {}
  private cost = { knownModelUsd: 0, pricedRequests: 0, unknownRequests: 0 }
  private output = { primaryContentTokens: 0, repairContentTokens: 0, reviewContentTokens: 0, reasoningTokens: 0, unknownContentRequests: 0 }
  private anyHitSamples = 0
  private records = 0
  private writtenRecords = 0
  private bytes = 0
  private initialized = false
  private startedAt = Date.now()
  private sequence = 0
  constructor(private options: { directory: string; taskId?: string; service: string; maxBytes?: number; maxTasks?: number; secrets?: readonly string[]; prices?: TokenPrices; experiment?: { strategy: string; extractionVersion: string; documentFingerprint?: string; translationPolicyVersion: string } }, readonly stats = initialUsage()) {
    const taskId = options.taskId && /^[a-zA-Z0-9-]{1,100}$/.test(options.taskId) ? options.taskId : randomUUID()
    this.file = join(options.directory, `${taskId}.jsonl`)
    this.summaryFile = join(options.directory, `${taskId}.summary.json`)
  }
  begin(body: DiagnosticRequest) { return this.observe(body, true) }
  private observe(body: DiagnosticRequest, remote: boolean) {
    const { fixed, ...prefix } = describePrefix(body)
    const group = fingerprint([this.options.service, body.model, body.thinking, body.reasoning_effort, prefix.type])
    const shape = canonicalJson(body.messages)
    const previous = this.previous.get(group)
    const prefixKey = fingerprint([group, prefix.fixedPrefixFingerprint])
    const cold = remote && !this.seenPrefixes.has(prefixKey)
    const changes: string[] = []
    let firstChangedByte: number | null = null
    if (remote) {
      this.seenPrefixes.add(prefixKey)
      if (previous) {
        const a = Buffer.from(previous.shape); const b = Buffer.from(shape)
        let offset = 0; while (offset < Math.min(a.length, b.length) && a[offset] === b[offset]) offset++
        if (offset < Math.max(a.length, b.length)) firstChangedByte = offset
        if (previous.rule !== prefix.ruleFingerprint) changes.push('rules')
        if (previous.context !== prefix.contextFingerprint) changes.push('context')
        if (previous.glossary !== prefix.glossaryFingerprint) changes.push('glossary')
        if (!changes.length && firstChangedByte !== null) changes.push('body-or-message-shape')
      }
      if (this.previous.size >= 64 && !previous) this.previous.delete(this.previous.keys().next().value!)
      this.previous.set(group, { shape, rule: prefix.ruleFingerprint, context: prefix.contextFingerprint, glossary: prefix.glossaryFingerprint })
    }
    return { ...prefix, group, cold, firstChangedByte, changes, sequence: remote ? ++this.sequence : null, sentAt: remote ? new Date().toISOString() : null }
  }
  record(observation: Observation) {
    const { cold, changes, firstChangedByte, ...prefix } = observation.prefixObservation ?? this.observe(observation.body, observation.source === 'remote')
    const usage = measureUsage(observation.usage)
    const totals = this.stats.cache!
    const phase = observation.phase ?? 'primary'
    const summary = this.groups[prefix.type] ??= { remoteAttempts: 0, samples: 0, hitTokens: 0, missTokens: 0, coldAttempts: 0, prefixChanges: 0, warmSamples: 0, warmHitTokens: 0, warmMissTokens: 0, completed: 0, errors: 0, cancelled: 0, usageMissing: 0, schedulerWaitMs: 0, completionTokens: 0, reasoningTokens: 0, contentTokens: 0, unknownContentRequests: 0, knownModelUsd: 0, unknownCostRequests: 0 }
    if (observation.source === 'remote') {
      const stage = this.phases[phase] ??= { remoteAttempts: 0, completionTokens: 0, contentTokens: 0, reasoningTokens: 0, knownModelUsd: 0, unknownCostRequests: 0 }
      const cost = modelCost(observation.usage, this.options.prices)
      const output = outputBreakdown(observation.usage)
      stage.remoteAttempts++; stage.completionTokens += usage.completionTokens ?? 0; stage.contentTokens += output.content ?? 0; stage.reasoningTokens += output.reasoning ?? 0
      summary.completionTokens += usage.completionTokens ?? 0; summary.reasoningTokens += output.reasoning ?? 0; summary.contentTokens += output.content ?? 0
      if (cost === null) { this.cost.unknownRequests++; summary.unknownCostRequests++; stage.unknownCostRequests++ }
      else { this.cost.knownModelUsd += cost; this.cost.pricedRequests++; summary.knownModelUsd += cost; stage.knownModelUsd += cost }
      this.output.reasoningTokens += output.reasoning ?? 0
      if (output.content === null) { this.output.unknownContentRequests++; summary.unknownContentRequests++ }
      else this.output[phase === 'repair' ? 'repairContentTokens' : phase === 'semantic-review' ? 'reviewContentTokens' : 'primaryContentTokens'] += output.content
      summary.remoteAttempts++
      if (cold) summary.coldAttempts++
      if (observation.outcome === 'completed') summary.completed++
      else if (observation.outcome === 'cancelled') summary.cancelled++
      else summary.errors++
      if (usage.source === 'missing') summary.usageMissing++
      summary.schedulerWaitMs += observation.schedulerWaitMs ?? 0
      if (changes.some(change => change !== 'body-or-message-shape')) summary.prefixChanges++
      this.stats.usageReported ||= [usage.promptTokens, usage.hitTokens, usage.missTokens, usage.completionTokens, usage.reasoningTokens].some(field => field !== null)
      this.stats.cacheUsageReported ||= usage.comparable
      this.stats.reasoningUsageReported ||= usage.reasoningTokens !== null
      this.stats.promptTokens += usage.promptTokens ?? 0
      this.stats.cachedPromptTokens += usage.hitTokens ?? 0
      this.stats.completionTokens += usage.completionTokens ?? 0
      this.stats.reasoningTokens += usage.reasoningTokens ?? 0
      for (const [field, value] of Object.entries({ prompt: usage.promptTokens, hit: usage.hitTokens, miss: usage.missTokens, completion: usage.completionTokens, reasoning: usage.reasoningTokens })) {
        if (value !== null) totals.fieldSamples[field as keyof typeof totals.fieldSamples]++
      }
      if (usage.completionTokens !== null) this.stats.completionElapsedMs! += observation.elapsedMs
      totals.rawMissTokens += usage.missTokens ?? 0
      if (usage.anomalies.length) totals.anomalousSamples++
      else if (!usage.comparable) totals.missingSamples++
      if (usage.comparable) {
        if (usage.hitTokens! > 0) this.anyHitSamples++
        totals.samples++; summary.samples++
        if (usage.estimatedMissTokens !== null) totals.estimatedSamples++
        totals.hitTokens += usage.hitTokens!; summary.hitTokens += usage.hitTokens!
        totals.missTokens += usage.missTokens ?? usage.estimatedMissTokens!; summary.missTokens += usage.missTokens ?? usage.estimatedMissTokens!
        if (!cold) { summary.warmSamples++; summary.warmHitTokens += usage.hitTokens!; summary.warmMissTokens += usage.missTokens ?? usage.estimatedMissTokens! }
      }
    }
    const modelLabel = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value) && !(this.options.secrets ?? []).some(secret => secret && value.includes(secret)) ? value : null
    const record = { taskId: this.file.split(/[\\/]/).pop()!.replace('.jsonl', ''), timestamp: new Date().toISOString(), requestId: observation.requestId, logicalFingerprint: observation.logicalFingerprint,
      attempt: observation.attempt, phase, source: observation.source, outcome: observation.outcome, httpStatus: observation.status ?? null, elapsedMs: observation.elapsedMs, inFlight: observation.inFlight, schedulerWaitMs: observation.schedulerWaitMs ?? 0,
      waitedForIdenticalRequest: observation.waited ?? false, serviceFingerprint: fingerprint(this.options.service), model: modelLabel(observation.body.model), modelFingerprint: fingerprint(observation.body.model), actualModel: modelLabel(observation.actualModel), actualModelFingerprint: typeof observation.actualModel === 'string' ? fingerprint(observation.actualModel) : null,
      reasoningEffort: ['low', 'high', 'max'].includes(String(observation.body.reasoning_effort)) ? observation.body.reasoning_effort : null, reasoningFingerprint: fingerprint([observation.body.thinking, observation.body.reasoning_effort]), ...prefix, localColdObservation: cold,
      firstChangedByte, changes, usage: observation.source === 'remote' ? usage : null }
    this.records++
    this.writes = this.writes.then(async () => {
      await this.initialize()
      const line = JSON.stringify(record) + '\n'
      if (this.bytes > 0 && this.bytes + Buffer.byteLength(line) > (this.options.maxBytes ?? 8 * 1024 * 1024)) {
        await rm(`${this.file}.2`, { force: true }); await rename(`${this.file}.1`, `${this.file}.2`).catch(error => { if (error.code !== 'ENOENT') throw error })
        await rename(this.file, `${this.file}.1`); this.bytes = 0
      }
      await appendFile(this.file, line, { mode: 0o600 }); this.bytes += Buffer.byteLength(line); this.writtenRecords++
    }).catch(() => { totals.diagnosticWriteFailures++ })
  }
  private async initialize() {
    if (this.initialized) return
    await mkdir(this.options.directory, { recursive: true })
    const files = await readdir(this.options.directory)
    const names = [...new Set(files.filter(file => file.endsWith('.jsonl') || file.endsWith('.summary.json')).map(file => file.replace(/(?:\.jsonl|\.summary\.json)$/, '')))].filter(name => join(this.options.directory, `${name}.jsonl`) !== this.file)
    const tasks = await Promise.all(names.map(async name => ({ file: `${name}.jsonl`, modified: await stat(join(this.options.directory, `${name}.summary.json`)).then(file => file.mtimeMs, async () => (await stat(join(this.options.directory, `${name}.jsonl`))).mtimeMs) })))
    tasks.sort((a, b) => b.modified - a.modified)
    for (const task of tasks.slice(Math.max(0, (this.options.maxTasks ?? 30) - 1))) {
      for (const file of [task.file, `${task.file}.1`, `${task.file}.2`, task.file.replace('.jsonl', '.summary.json')]) await rm(join(this.options.directory, file), { force: true })
    }
    this.bytes = await stat(this.file).then(file => file.size, () => 0)
    this.initialized = true
  }
  async flush() {
    await this.writes
    await this.initialize().catch(() => { this.stats.cache!.diagnosticWriteFailures++ })
    await writeJson(this.summaryFile, { version: 2, stats: this.stats, byType: this.groups, byPhase: this.phases, output: this.output, cost: this.cost, prices: this.options.prices ?? null, experiment: this.options.experiment ?? null, anyHitRequestRate: this.stats.cache!.samples ? this.anyHitSamples / this.stats.cache!.samples : null, localParagraphReuseRate: this.stats.paragraphs?.total ? this.stats.paragraphs.reused / this.stats.paragraphs.total : null, records: this.records, writtenRecords: this.writtenRecords, startedAt: this.startedAt, finishedAt: Date.now(), elapsedMs: Date.now() - this.startedAt, serverMeasurement: 'provider-reported', hitRate: this.stats.cache!.hitTokens + this.stats.cache!.missTokens ? this.stats.cache!.hitTokens / (this.stats.cache!.hitTokens + this.stats.cache!.missTokens) : null }).catch(() => { this.stats.cache!.diagnosticWriteFailures++ })
  }
}
