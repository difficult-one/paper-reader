import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { writeJson } from './store'
import { prepareTranslationRequest, startTranslationGateway, type ChatRequest } from './translation-gateway'
import { canonicalJson } from './translation-prompts'
import { describePrefix } from './cache-diagnostics'
import { ruleBundle } from './translation-policy'
import { TRANSLATION_POLICY_VERSION } from './cache-versions'
import { UsageBudget, type TokenPrices } from './translation-cost'
import type { ServiceSettings } from '../shared/types'
import { assessTranslationAcceptance, prepareBlindReview, type AcceptanceCase, type AcceptanceRun } from './translation-acceptance'
export { assessTranslationAcceptance } from './translation-acceptance'
export { verifyHumanLayoutReview } from './translation-layout-review'
export const currentAcceptancePolicy = TRANSLATION_POLICY_VERSION

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const seed = 'translation-acceptance-2026-10-18-v1'
const completedFiles = ['collection-state.json', 'budget-ledger.json', 'outputs.json', 'source-cases.json', 'policies.json', 'request-plan.json', 'experiment.json']
async function completionHashes(directory: string) {
  return Object.fromEntries(await Promise.all(completedFiles.map(async name => [name, sha(await readFile(join(directory, name), 'utf8'))])))
}
export async function verifyCollectionCosts(directory: string): Promise<'known' | 'unknown'> {
  try {
    const load = async (name: string) => JSON.parse(await readFile(join(directory, name), 'utf8'))
    const completion = await load('collection-completion.json')
    const state = await load('collection-state.json'); const ledger = await load('budget-ledger.json')
    if (completion.schemaVersion !== 1 || completion.status !== 'collected' || state.status !== 'collected' || ledger.mode !== 'live' || ledger.unknownRequests !== 0 || ledger.reservedUsd !== 0 || !Number.isFinite(ledger.knownUsd) || ledger.knownUsd < 0 || JSON.stringify(completion.files) !== JSON.stringify(await completionHashes(directory))) return 'unknown'
    return 'known'
  } catch { return 'unknown' }
}
async function withDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true })
  const lockPath = join(directory, 'acceptance.lock')
  let lock
  try { lock = await open(lockPath, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Acceptance directory is locked by another experiment; preserve its outputs and ledger')
    throw error
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await operation() }
  finally { await lock.close(); await unlink(lockPath) }
}
function requestPlan(cases: AcceptanceCase[], baselineSystem: string) {
  const boundary = baselineSystem.indexOf('## Research translation quality')
  if (boundary < 0) throw new Error('Baseline requires a frozen original body template and research rules')
  const template = baselineSystem.slice(0, boundary).replace(/\r\n/g, '\n').trim()
  const documents = [...new Set(cases.map(sample => sample.documentId))]
  return documents.flatMap(documentId => {
    const samples = cases.filter(sample => sample.documentId === documentId)
    const context = `## Contextual Hints for Better Translation\nFirst title: ${documentId}\n\n## Frozen source context (source data only)\n${canonicalJson(samples.map(sample => ({ paragraphId: sample.id, page: sample.page, source: sample.source })))}`
    const batches = []
    for (let start = 0; start < samples.length; start += 5) {
      const selected = samples.slice(start, start + 5)
      const user = `${context}\n\n## Here is the input:\n${canonicalJson(selected.map(sample => ({ id: sample.id, input: sample.source })))}`
      const original: ChatRequest = { messages: [{ role: 'system', content: baselineSystem.trim() }, { role: 'user', content: user }] }
      const candidate = prepareTranslationRequest({ messages: [{ role: 'user', content: `${template}\n\n${user}` }] }, { baseUrl: 'https://example.org/v1', apiKey: '', model: 'selected-at-runtime', qps: 1 })
      if (describePrefix(original).type !== 'batch' || describePrefix(candidate).type !== 'batch' || candidate.messages.length !== 2 || !candidate.messages[0].content.includes(ruleBundle.core.trim()) || !candidate.messages[0].content.includes(ruleBundle.body.trim())) throw new Error('Acceptance preflight requires recognized batches and the actual compiled candidate rules')
      batches.push({ id: `${documentId}-${start / 5 + 1}`, documentId, caseIds: selected.map(sample => sample.id), requests: { baseline: original, candidate }, order: parseInt(sha(`${seed}:${documentId}:${start}`).slice(0, 2), 16) % 2 ? ['candidate', 'baseline'] as const : ['baseline', 'candidate'] as const })
    }
    return batches
  })
}

async function persistEvaluation(cases: AcceptanceCase[], runs: AcceptanceRun[], directory: string, costs: 'known' | 'unknown') {
  const { salt } = JSON.parse(await readFile(join(directory, 'blind-private.json'), 'utf8'))
  const policies = JSON.parse(await readFile(join(directory, 'policies.json'), 'utf8'))
  const material = prepareBlindReview(cases, runs, salt)
  const acceptance = assessTranslationAcceptance(cases, runs, material.key, [], { policies, costs, layout: 'pending' })
  await writeJson(join(directory, 'outputs.json'), runs)
  await writeJson(join(directory, 'blind-review.json'), material.review)
  await writeJson(join(directory, 'blind-key.json'), material.key)
  await writeJson(join(directory, 'acceptance-status.json'), acceptance)
  return acceptance
}

export async function prepareTranslationAcceptance(cases: AcceptanceCase[], baselineSystem: string, directory: string) {
  return withDirectoryLock(directory, () => prepareUnlocked(cases, baselineSystem, directory))
}
async function prepareUnlocked(cases: AcceptanceCase[], baselineSystem: string, directory: string) {
  try { await access(join(directory, 'collection-state.json')); throw new Error('An experiment already started in this directory; preserve existing outputs and ledger') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  prepareBlindReview(cases, [], seed)
  const plan = requestPlan(cases, baselineSystem)
  const policies = { baseline: `archived-body-${sha(baselineSystem.trim())}`, candidate: TRANSLATION_POLICY_VERSION }
  await writeJson(join(directory, 'blind-private.json'), { salt: randomBytes(32).toString('hex') })
  await writeJson(join(directory, 'source-cases.json'), cases)
  await writeJson(join(directory, 'request-plan.json'), plan)
  await writeJson(join(directory, 'policies.json'), { ...policies, baselineOrigin: 'Archived actual body system prompt in output/fidelity-economy-validation/sample-inputs.json (2026-10-17)', comparison: 'Prompt policy comparison with the same model/effort and current deterministic validators. Does not reproduce the entire historical application.', semanticReview: 'candidate uses separate risk review; baseline does not', seed })
  const runs: AcceptanceRun[] = cases.flatMap(sample => (['baseline', 'candidate'] as const).map(arm => ({ caseId: sample.id, sourceHash: sample.sourceHash, arm, policy: policies[arm], status: 'missing', output: '' })))
  await persistEvaluation(cases, runs, directory, 'unknown')
  return { cases: cases.length, papers: new Set(cases.map(sample => sample.documentId)).size, disciplines: new Set(cases.map(sample => sample.discipline)).size, primaryRequests: plan.length * 2, candidateReviewRequests: `0–${plan.length}; repairs may add further requests`, policies }
}

interface CollectionOptions { settings: Omit<ServiceSettings, 'apiKey'>; apiKey: string; budgetUsd: number; prices: TokenPrices; maxInputTokens: number; maxOutputTokens: number; signal?: AbortSignal }
export async function collectTranslationAcceptance(cases: AcceptanceCase[], baselineSystem: string, directory: string, options: CollectionOptions) {
  if (!options.apiKey?.trim() || !options.budgetUsd) throw new Error('Live collection requires an explicit API key and budget')
  return withDirectoryLock(directory, () => collectUnlocked(cases, baselineSystem, directory, options))
}
async function collectUnlocked(cases: AcceptanceCase[], baselineSystem: string, directory: string, options: CollectionOptions) {
  const budget = new UsageBudget({ limitUsd: options.budgetUsd, prices: options.prices, maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens })
  try { await access(join(directory, 'collection-state.json')); throw new Error('Collection already started; inspect its budget ledger before choosing a new output directory') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const prepared = await prepareUnlocked(cases, baselineSystem, directory)
  const runs = JSON.parse(await readFile(join(directory, 'outputs.json'), 'utf8')) as AcceptanceRun[]
  const plan = requestPlan(cases, baselineSystem)
  const settings = { ...options.settings, apiKey: options.apiKey, translationMode: 'manual' as const, reasoningEffort: options.settings.reasoningEffort ?? 'high' as const }
  const state = { status: 'running', startedAt: new Date().toISOString(), error: null as string | null, finishedAt: null as string | null }
  await writeJson(join(directory, 'experiment.json'), { schemaVersion: 1, service: { baseUrl: settings.baseUrl, model: settings.model, qps: settings.qps, reasoningEffort: settings.reasoningEffort, translationMode: settings.translationMode }, budget: { limitUsd: options.budgetUsd, prices: options.prices, maxInputTokens: options.maxInputTokens, maxOutputTokens: options.maxOutputTokens }, startedAt: state.startedAt })
  await writeJson(join(directory, 'collection-state.json'), state)
  let failed = false
  try {
    for (const batch of plan) {
      if (failed || budget.snapshot().unknownRequests) break
      for (const arm of batch.order) {
        options.signal?.throwIfAborted()
        const request = { ...batch.requests[arm], max_tokens: options.maxOutputTokens }
        // Reserve using a user-provided model contract; never send a larger input silently.
        if (Buffer.byteLength(JSON.stringify(request), 'utf8') > options.maxInputTokens) throw new Error('Prepared request exceeds the declared conservative input allowance')
        const gateway = await startTranslationGateway({ settings, cacheDir: join(directory, 'cache', arm), diagnosticsDir: join(directory, 'diagnostics', batch.id, arm), taskId: `${batch.id}-${arm}`, documentFingerprint: sha(batch.documentId), translationPolicyVersion: prepared.policies[arm], prices: options.prices, budget, signal: options.signal, quality: arm === 'candidate' ? { directory: join(directory, 'quality', batch.id), cacheDirectory: join(directory, 'review-cache') } : undefined, onParagraph: async paragraph => {
          const sample = cases.find(sample => sample.id === paragraph.id && batch.caseIds.includes(sample.id))
          if (!sample || sample.source !== paragraph.input) throw new Error('Validated paragraph does not match its frozen source')
          const run = runs.find(run => run.caseId === sample.id && run.arm === arm)!
          run.status = 'completed'; run.output = paragraph.output
          await writeJson(join(directory, 'outputs.json'), runs)
        }, onProviderFailure: failure => {
          failed = true
          state.error = `Provider ${failure.phase} failed (${failure.status === null ? 'network' : `HTTP ${failure.status}`}); stopped without automatic paid restart`
        } })
        try {
          const response = await fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: options.signal })
          const body = await response.json()
          let outputs: { id: string; output: string }[] = []
          try { outputs = JSON.parse(body.choices?.[0]?.message?.content ?? '[]') } catch { /* All affected source IDs stay failed. */ }
          for (const id of batch.caseIds) {
            const run = runs.find(run => run.caseId === id && run.arm === arm)!
            const matches = Array.isArray(outputs) ? outputs.filter(item => item?.id === id && typeof item.output === 'string' && item.output.trim()) : []
            if (response.ok && matches.length === 1) { run.status = 'completed'; run.output = matches[0].output }
            else if (run.status !== 'completed') { run.status = 'failed'; run.output = '' }
          }
          if (!response.ok) {
            const structural = body.error?.code === 'translation-structure-failure'
            if (!structural) failed = true
            state.error ??= structural ? 'Some paragraphs failed structural validation; retained failures and continued remaining planned batches without retrying them' : `Translation request failed (HTTP ${response.status}); stopped without automatic paid restart`
          }
        } finally {
          await gateway.close()
          await writeJson(join(directory, 'budget-ledger.json'), { mode: 'live', prices: options.prices, ...budget.snapshot() })
          await persistEvaluation(cases, runs, directory, budget.snapshot().unknownRequests ? 'unknown' : 'known')
        }
        if (failed || budget.snapshot().unknownRequests) break
      }
    }
  } catch (error) { failed = true; state.error = String(error instanceof Error ? error.message : error).split(options.apiKey).join('[hidden]') }
  finally {
    state.status = failed || runs.some(run => run.status !== 'completed') ? 'incomplete' : 'collected'
    state.finishedAt = new Date().toISOString()
    await writeJson(join(directory, 'collection-state.json'), state)
    await writeJson(join(directory, 'budget-ledger.json'), { mode: 'live', prices: options.prices, ...budget.snapshot() })
  }
  const acceptance = await persistEvaluation(cases, runs, directory, budget.snapshot().unknownRequests ? 'unknown' : 'known')
  if (state.status === 'collected') await writeJson(join(directory, 'collection-completion.json'), { schemaVersion: 1, status: 'collected', files: await completionHashes(directory) })
  return { ...prepared, state, budget: budget.snapshot(), acceptance }
}
