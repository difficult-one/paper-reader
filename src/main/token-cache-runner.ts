import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { experimentSchedule } from './token-cache-experiment'
import { prepareTranslationRequest, startTranslationGateway, type ChatRequest } from './translation-gateway'
import { parseBatch } from './paragraph-cache'
import { UsageBudget, type TokenPrices } from './translation-cost'
import { EXTRACTION_VERSION, TRANSLATION_POLICY_VERSION } from './cache-versions'
import { fingerprint } from './cache-diagnostics'
import type { ServiceSettings } from '../shared/types'

interface ExperimentDocument {
  id: string; discipline: string; sourceTokens: number; extractionVersion: string;
  requests: ChatRequest[]; translations?: Record<string, string>; terms?: { src: string; tgt: string }[]
}
export interface ExperimentManifest { settings: Omit<ServiceSettings, 'apiKey'>; prices: TokenPrices; contextWindowTokens: number; documents: ExperimentDocument[] }
export function offlineFixture(): ExperimentManifest {
  const source = ['Rotor flux is defined as magnetic flux.', 'The rotor rotates smoothly.', 'It did not increase with 20 samples.']
  return { settings: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', qps: 8, translationMode: 'economy' }, prices: { hit: .006, miss: .30, output: 1.20 }, contextWindowTokens: 1_048_576,
    documents: [{ id: 'offline-rotor', discipline: 'electrical-engineering', extractionVersion: EXTRACTION_VERSION, sourceTokens: 30,
      requests: [
        { messages: [{ role: 'user', content: `You are an expert multilingual terminologist.\n### Extraction Rules\nExtract domain nouns.\n### Translation Rules\nPreserve definitions.\n### Output Format\nReturn JSON src/tgt.\nInput Text:\n\x60\x60\x60\n${source[0]}\n\x60\x60\x60` }] },
        { messages: [{ role: 'user', content: `You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nReturn JSON.\n## Here is the input:\n${JSON.stringify(source.slice(1).map((input, id) => ({ id, input })))}` }] }
      ], terms: [{ src: 'Rotor flux', tgt: '转子磁通' }], translations: { [source[1]]: '转子平稳旋转。', [source[2]]: '在 20 个样本下没有增加。' }
    }] }
}
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
export async function runTokenExperiment(manifest: ExperimentManifest, options: { directory: string; live: boolean; budgetUsd?: number; apiKey?: string; seed?: number; signal?: AbortSignal }) {
  if (!manifest.documents.length || manifest.documents.some(doc => !/^[a-zA-Z0-9_-]{1,64}$/.test(doc.id) || !doc.discipline || !doc.extractionVersion || !Number.isSafeInteger(doc.sourceTokens) || doc.sourceTokens <= 0 || !Array.isArray(doc.requests) || !doc.requests.length)) throw new Error('实验文档需要安全且唯一的 ID、学科、提取版本、源文 token 数和请求。')
  if (new Set(manifest.documents.map(doc => doc.id)).size !== manifest.documents.length) throw new Error('文档 ID 不能重复。')
  if (options.live && (!options.apiKey || !options.budgetUsd)) throw new Error('真实实验需要独立 API 密钥与明确的 --budget-usd。')
  if (options.live && (new URL(manifest.settings.baseUrl).hostname !== 'api.deepseek.com' || !['deepseek-flash', 'deepseek-v4-pro'].includes(manifest.settings.model))) throw new Error('当前真实实验只支持已验证参数的官方 DeepSeek 模型。')
  const allRequests = manifest.documents.flatMap(doc => doc.requests)
  const maxOutputTokens = Math.max(65536, ...allRequests.map(body => Number(body.max_tokens ?? 65536)))
  const schedule = experimentSchedule({ documents: manifest.documents.map(doc => doc.id), seed: options.seed ?? 42, repetitions: 3 })
  await mkdir(options.directory, { recursive: true })
  if ((await readdir(options.directory)).some(entry => entry !== 'runner')) throw new Error('已有实验结果或缓存，请使用新的独立输出目录，禁止重复污染冷态。')
  await writeFile(join(options.directory, 'experiment-lock.json'), JSON.stringify({ id: randomUUID(), mode: options.live ? 'live' : 'offline', startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  const budget = options.live ? new UsageBudget({ limitUsd: options.budgetUsd!, prices: manifest.prices, maxInputTokens: manifest.contextWindowTokens, maxOutputTokens, checkpoint: snapshot => {
    const temporary = join(options.directory, 'budget.tmp')
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
    renameSync(temporary, join(options.directory, 'budget.json'))
  } }) : undefined
  await writeFile(join(options.directory, 'schedule.json'), JSON.stringify(schedule, null, 2))
  const nativeFetch = globalThis.fetch
  let currentDocument: ExperimentDocument
  let syntheticCalls = 0
  if (!options.live) globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).hostname === '127.0.0.1') return nativeFetch(url, init)
    const body = JSON.parse(String(init?.body)) as ChatRequest
    const batch = parseBatch(body)
    const content = batch ? batch.paragraphs.map(p => {
      const output = currentDocument.translations?.[p.input]
      if (output === undefined) throw new Error('离线样本缺少对应译文。')
      return { id: p.id, output }
    }) : (currentDocument.terms ?? []).filter(term => body.messages.at(-1)!.content.includes(term.src))
    syntheticCalls++
    const reasoning = (body.thinking as { type?: string })?.type === 'disabled' ? 0 : 40
    return new Response(JSON.stringify({ model: 'offline-fixture-v1', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 20 + reasoning, completion_tokens_details: { reasoning_tokens: reasoning } } }))
  }
  const runs: any[] = []; const blind: string[][] = []; const blindKey: any[] = []
  const sendRun = async (run: typeof schedule[number], doc: ExperimentDocument, preparation: boolean) => {
    const taskId = `${run.cacheNamespace}-${preparation ? 'prepare' : 'measure'}`
    const gateway = await startTranslationGateway({ settings: { ...manifest.settings, apiKey: options.apiKey ?? 'offline-only', translationMode: 'economy' }, strategy: run.strategy, cacheDir: join(options.directory, 'cache', run.cacheNamespace), diagnosticsDir: join(options.directory, 'diagnostics', taskId), taskId, documentFingerprint: fingerprint(doc.id), extractionVersion: doc.extractionVersion, prices: options.live ? manifest.prices : undefined, budget, signal: options.signal })
    const results: { ok: boolean; status: number; content?: string }[] = []
    const started = performance.now()
    try {
      for (const request of doc.requests) {
        options.signal?.throwIfAborted()
        const response = await fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ ...request, max_tokens: request.max_tokens ?? 65536 }) })
        const body = await response.json()
        results.push({ ok: response.ok, status: response.status, content: body.choices?.[0]?.message?.content })
        if (!response.ok) break
        if (!preparation && typeof body.choices?.[0]?.message?.content === 'string') {
          const batchRequest = parseBatch(prepareTranslationRequest(request, { ...manifest.settings, apiKey: 'unused' }, run.strategy))
          if (batchRequest) {
            const outputs = JSON.parse(body.choices[0].message.content)
            for (const paragraph of batchRequest.paragraphs) {
              const id = randomUUID(); const output = outputs.find((item: any) => item.id === paragraph.id)?.output ?? ''
              blind.push([id, paragraph.input, output, '', '', ''])
              blindKey.push({ blindId: id, ...run, paragraphId: paragraph.id })
            }
          }
        }
      }
    } finally { await gateway.close() }
    const records = await readFile(gateway.diagnosticsFile, 'utf8').catch(() => '')
    const actualModels = [...new Set(records.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(record => record.source === 'remote' && record.actualModel).map(record => record.actualModel))]
    return { ...run, preparation, elapsedMs: performance.now() - started, sourceTokens: doc.sourceTokens, actualModels, structure: results.length === doc.requests.length && results.every(result => result.ok) ? 'passed' : 'failed', semantic: 'pending-blind-review', layout: 'not-measured', results, diagnostics: JSON.parse(await readFile(gateway.diagnosticsSummaryFile, 'utf8')) }
  }
  try {
    for (const run of schedule) {
      currentDocument = manifest.documents.find(doc => doc.id === run.document)!
      if (run.cacheState === 'warm') {
        runs.push(await sendRun(run, currentDocument, true))
        if (budget?.snapshot().stoppedReason) break
      }
      runs.push(await sendRun(run, currentDocument, false))
      if (budget?.snapshot().stoppedReason) break
    }
  } finally { globalThis.fetch = nativeFetch }
  const comparisons = (['baseline', 'terminology', 'adaptive'] as const).flatMap(strategy => (['cold', 'warm'] as const).map(cacheState => {
    const measured = runs.filter(run => !run.preparation && run.strategy === strategy && run.cacheState === cacheState)
    const elapsed = measured.map(run => run.elapsedMs).sort((a, b) => a - b)
    const sourceTokens = measured.reduce((sum, run) => sum + run.sourceTokens, 0)
    const unknownCosts = measured.reduce((sum, run) => sum + run.diagnostics.cost.unknownRequests, 0)
    const cost = measured.reduce((sum, run) => sum + run.diagnostics.cost.knownModelUsd, 0)
    const totalParagraphs = measured.reduce((sum, run) => sum + run.diagnostics.stats.paragraphs.total, 0)
    const reused = measured.reduce((sum, run) => sum + run.diagnostics.stats.paragraphs.reused, 0)
    return { strategy, cacheState, samples: measured.length, sourceTokens, costPer10kSourceTokensUsd: options.live && sourceTokens && !unknownCosts ? cost / sourceTokens * 10000 : null, unknownCosts, p95ElapsedMs: elapsed.length ? elapsed[Math.ceil(.95 * elapsed.length) - 1] : null, localParagraphReuseRate: totalParagraphs ? reused / totalParagraphs : null }
  }))
  const report = { version: 1, mode: options.live ? 'live' : 'offline-synthetic', translationPolicy: TRANSLATION_POLICY_VERSION, requestedModel: manifest.settings.model, serverCacheState: 'provider-reported-only; cold/warm labels describe local result caches', documents: manifest.documents.map(({ id, discipline, extractionVersion, sourceTokens }) => ({ id, discipline, extractionVersion, sourceTokens })), syntheticCalls, budget: budget?.snapshot() ?? null, prices: options.live ? manifest.prices : null, pricingBasis: 'supplied-price-estimate; provider invoice not available', comparisons,
    release: { ready: false, semantic: 'pending-blind-review', layout: 'not-measured', reason: '离线结果仅验证结构；真实实验仍需源文盲评、版面验收和按学科/样本数报告不确定性。' }, runs }
  await writeFile(join(options.directory, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(options.directory, 'blind-review.csv'), '\uFEFF' + [['blindId', 'source', 'translation', 'seriousErrors', 'ordinaryErrors', 'notes'], ...blind].map(row => row.map(csvCell).join(',')).join('\n'))
  await writeFile(join(options.directory, 'blind-key.json'), JSON.stringify(blindKey, null, 2))
  return { directory: options.directory, mode: report.mode, runs: runs.length, measurements: runs.filter(run => !run.preparation).length, structureFailures: runs.filter(run => run.structure !== 'passed').length, budget: report.budget }
}
