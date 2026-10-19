import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheDiagnostics, measureUsage } from '../src/main/cache-diagnostics'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'cache-diagnostics-')); directories.push(dir); return dir }
const observation = { source: 'remote' as const, outcome: 'completed' as const, requestId: 'request', logicalFingerprint: 'logical', attempt: 1, body: { model: 'm', messages: [{ role: 'user', content: 'private-body' }] }, elapsedMs: 25, inFlight: 1 }

it.each([
  [{ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 25 } }, { comparable: true, hitTokens: 25, missTokens: null, estimatedMissTokens: 75 }],
  [{ prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 }, { comparable: true, promptTokens: null, hitTokens: 3, missTokens: 7 }],
  [{ prompt_tokens: 100 }, { comparable: false, hitTokens: null, missTokens: null }],
  [{ prompt_tokens: 100, prompt_cache_hit_tokens: 101 }, { comparable: false }],
  [{ prompt_tokens: 10, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: -1 }, { comparable: false, estimatedMissTokens: null }],
  [{ prompt_tokens: NaN, prompt_cache_hit_tokens: 0 }, { comparable: false }],
  [{ prompt_tokens: 10, prompt_cache_hit_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } }, { comparable: false }]
])('保留原始 usage 与缺失状态 %#', (input, expected) => { expect(measureUsage(input)).toMatchObject(expected) })

it('日志写入失败不会抛给翻译调用，缺失计入完整性', async () => {
  const dir = await directory(); const blocked = join(dir, 'file'); await writeFile(blocked, 'block')
  const diagnostics = new CacheDiagnostics({ directory: blocked, service: 'https://example.com' })
  diagnostics.record(observation)
  await expect(diagnostics.flush()).resolves.toBeUndefined()
  expect(diagnostics.stats.cache!.diagnosticWriteFailures).toBeGreaterThan(0)
})

it('按任务轮转日志，并生成按类型汇总和写入覆盖率', async () => {
  const dir = await directory()
  for (let task = 0; task < 3; task++) {
    const diagnostics = new CacheDiagnostics({ directory: dir, service: 'https://example.com', taskId: `task-${task}`, maxTasks: 2, maxBytes: 2200 })
    for (let i = 0; i < 5; i++) diagnostics.record({ ...observation, usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } })
    await diagnostics.flush()
  }
  const files = await readdir(dir)
  expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(2)
  expect(files.some(file => file.startsWith('task-0.'))).toBe(false)
  expect(files).toContain('task-2.jsonl.2')
  const report = JSON.parse(await readFile(join(dir, 'task-2.summary.json'), 'utf8'))
  expect(report).toMatchObject({ records: 5, writtenRecords: 5, byType: { unknown: { remoteAttempts: 5, samples: 5, hitTokens: 20, missTokens: 30 } }, hitRate: 0.4 })
})

it('数值异常原样留在 raw 字段，推算值不能覆盖原始值', () => {
  expect(measureUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 11 }).raw).toMatchObject({ prompt_tokens: 10, prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 11 })
})

it('仅有 H/M 也可统计比例，各用量字段分别报告覆盖率', async () => {
  const diagnostics = new CacheDiagnostics({ directory: await directory(), service: 'https://api.deepseek.com/v1' })
  diagnostics.record({ ...observation, usage: { prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
  expect(diagnostics.stats.usageReported).toBe(true)
  expect(diagnostics.stats.cache!.fieldSamples).toMatchObject({ prompt: 0, hit: 1, miss: 1, completion: 0, reasoning: 0 })
  await diagnostics.flush()
})

it('超过软字节上限的首条记录仍可写入且后续正常轮转', async () => {
  const dir = await directory()
  const diagnostics = new CacheDiagnostics({ directory: dir, taskId: 'large-record', service: 'https://example.com', maxBytes: 1 })
  diagnostics.record(observation); diagnostics.record(observation)
  await diagnostics.flush()
  const report = JSON.parse(await readFile(diagnostics.summaryFile, 'utf8'))
  expect(report.writtenRecords).toBe(2)
  expect(report.stats.cache.diagnosticWriteFailures).toBe(0)
})

it('新固定前缀分别标记本地冷启动，并给出热阶段样本及成功失败数量', async () => {
  const diagnostics = new CacheDiagnostics({ directory: await directory(), service: 'https://api.deepseek.com/v1' })
  const body = (title: string, text: string) => ({ model: 'deepseek-flash', reasoning_effort: 'high', messages: [{ role: 'system', content: 'You are a professional zh translator.\n## Structure Rules\nKeep IDs.' }, { role: 'user', content: `## Contextual Hints for Better Translation\nFirst title: ${title}\n\n## Here is the input:\n[{"id":0,"input":"${text}"}]` }] })
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }
  diagnostics.record({ ...observation, body: body('A', 'one'), usage })
  diagnostics.record({ ...observation, body: body('A', 'two'), usage })
  diagnostics.record({ ...observation, body: body('B', 'three'), outcome: 'error' })
  await diagnostics.flush()
  const records = (await readFile(diagnostics.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.map(record => record.localColdObservation)).toEqual([true, false, true])
  expect(records[0]).toMatchObject({ model: 'deepseek-flash', reasoningEffort: 'high' })
  const report = JSON.parse(await readFile(diagnostics.summaryFile, 'utf8'))
  expect(report.byType.batch).toMatchObject({ coldAttempts: 2, warmSamples: 1, warmHitTokens: 60, warmMissTokens: 40, completed: 2, errors: 1 })
})

it('没有请求记录的任务汇总也按任务数量轮转', async () => {
  const dir = await directory()
  for (let i = 0; i < 3; i++) await new CacheDiagnostics({ directory: dir, service: 'https://example.com', taskId: `no-requests-${i}`, maxTasks: 2 }).flush()
  expect((await readdir(dir)).filter(file => file.endsWith('.summary.json'))).toHaveLength(2)
})

it('并发响应乱序时仍按实际发送顺序诊断前缀变化', async () => {
  const diagnostics = new CacheDiagnostics({ directory: await directory(), service: 'https://example.com' })
  const a = { model: 'm', messages: [{ role: 'system', content: 'First rules' }, { role: 'user', content: 'private A' }] }
  const b = { model: 'm', messages: [{ role: 'system', content: 'Second rules' }, { role: 'user', content: 'private B' }] }
  const first = diagnostics.begin(a); const second = diagnostics.begin(b)
  diagnostics.record({ ...observation, body: b, prefixObservation: second })
  diagnostics.record({ ...observation, body: a, prefixObservation: first })
  await diagnostics.flush()
  const records = (await readFile(diagnostics.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(records.map(record => record.sequence)).toEqual([2, 1])
  expect(records[1].firstChangedByte).toBeNull()
  expect(records[0].changes).toContain('rules')
})

it('按任务和修复阶段拆分内容/思考/费用，缺失用量明确报告未知，本地复用不进入费用分母', async () => {
  const diagnostics = new CacheDiagnostics({ directory: await directory(), service: 'https://example.com', prices: { hit: 0.006, miss: 0.30, output: 1.20 } })
  const usage = { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 40 } }
  diagnostics.record({ ...observation, usage })
  diagnostics.record({ ...observation, usage, phase: 'repair' })
  diagnostics.record({ ...observation, outcome: 'cancelled' })
  diagnostics.record({ ...observation, source: 'request-cache' })
  await diagnostics.flush()
  const report = JSON.parse(await readFile(diagnostics.summaryFile, 'utf8'))
  expect(report.byPhase.repair).toMatchObject({ remoteAttempts: 1, completionTokens: 50, contentTokens: 10, reasoningTokens: 40 })
  expect(report.cost).toMatchObject({ pricedRequests: 2, unknownRequests: 1 })
  expect(report.cost.knownModelUsd).toBeCloseTo(0.00014472, 10)
  expect(report.output).toMatchObject({ primaryContentTokens: 10, repairContentTokens: 10, reasoningTokens: 80, unknownContentRequests: 1 })
  expect(report.anyHitRequestRate).toBe(1)
})
