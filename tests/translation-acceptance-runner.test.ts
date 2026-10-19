import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { prepareTranslationAcceptance, collectTranslationAcceptance, verifyCollectionCosts } from '../src/main/translation-acceptance-runner'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'acceptance-runner-')); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir }
const cases = [{ id: 'case-1', documentId: 'paper', discipline: 'engineering', source: 'The method may improve stability with 10 samples.', page: 1, sourceUrl: 'https://example.org/paper', rect: [.1, .1, .6, .1] }].map(sample => ({ ...sample, sourceHash: createHash('sha256').update(sample.source).digest('hex') }))
const system = 'You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nJSON.\n## Research translation quality\nHistorical faithful translation rules.'
it('prepares both real prompt policies and missing-output review templates without remote calls', async () => {
  const dir = await directory()
  const plan = await prepareTranslationAcceptance(cases, system.replaceAll('\n', '\r\n'), dir)
  expect(plan.cases).toBe(1)
  expect(plan.primaryRequests).toBe(2)
  const report = JSON.parse(await readFile(join(dir, 'acceptance-status.json'), 'utf8'))
  expect(report.ready).toBe(false)
  expect(report.denominators.baseline.translated).toBe(0)
  const requests = JSON.parse(await readFile(join(dir, 'request-plan.json'), 'utf8'))
  expect(requests[0].requests.baseline.messages[0].content).toContain('Historical faithful')
  expect(requests[0].requests.candidate.messages[0].content).toContain('Research body rules')
  expect(requests[0].requests.candidate.messages[0].content).not.toContain('Historical faithful')
  expect(requests[0].requests.candidate.messages).toHaveLength(2)
})
it('refuses live collection without both a key and explicit cost ceiling', async () => {
  const dir = await directory()
  await expect(collectTranslationAcceptance(cases, system, dir, { settings: { baseUrl: 'https://example.org/v1', model: 'test', qps: 2 }, prices: { hit: .01, miss: .1, output: .2 }, maxInputTokens: 4096, maxOutputTokens: 4096 } as any)).rejects.toThrow(/key|budget/i)
})
it('rejects an unrecognized candidate template in no-network preflight', async () => {
  await expect(prepareTranslationAcceptance(cases, system.replace('You are a professional', 'An unrecognized'), await directory())).rejects.toThrow(/preflight|compiled|recognized/i)
})
it('cannot overwrite an already started paid experiment by preparing its directory again', async () => {
  const dir = await directory()
  await writeFile(join(dir, 'collection-state.json'), '{"status":"incomplete"}')
  await writeFile(join(dir, 'outputs.json'), 'preserve paid outputs')
  await expect(prepareTranslationAcceptance(cases, system, dir)).rejects.toThrow(/started|existing/i)
  expect(await readFile(join(dir, 'outputs.json'), 'utf8')).toBe('preserve paid outputs')
})
it('refuses preparation and collection while another process holds the directory lock', async () => {
  const dir = await directory()
  await writeFile(join(dir, 'acceptance.lock'), '{"pid":99999}')
  await writeFile(join(dir, 'outputs.json'), 'preserve paid outputs')
  await expect(prepareTranslationAcceptance(cases, system, dir)).rejects.toThrow(/locked/i)
  await expect(collectTranslationAcceptance(cases, system, dir, { settings: { baseUrl: 'https://example.org/v1', model: 'test', qps: 2 }, apiKey: 'local-test', budgetUsd: 1, prices: { hit: .01, miss: .1, output: .2 }, maxInputTokens: 4096, maxOutputTokens: 4096 })).rejects.toThrow(/locked/i)
  expect(await readFile(join(dir, 'outputs.json'), 'utf8')).toBe('preserve paid outputs')
})
it('persists validated paid siblings even when another paragraph fails the aggregate batch', async () => {
  const dir = await directory(); let calls = 0
  const samples = [...cases, { ...cases[0], id: 'case-2' }]
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the request */ }
    calls++
    res.writeHead(calls === 1 ? 200 : 502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify([{ id: 'case-1', output: '该方法在 10 个样本下可能提高稳定性。' }]) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 30 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const result = await collectTranslationAcceptance(samples, system, dir, { settings: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test', qps: 20 }, apiKey: 'test-only', budgetUsd: 1, prices: { hit: .01, miss: .1, output: .2 }, maxInputTokens: 8192, maxOutputTokens: 4096 })
  const outputs = JSON.parse(await readFile(join(dir, 'outputs.json'), 'utf8'))
  expect(outputs.filter((row: any) => row.status === 'completed')).toEqual([expect.objectContaining({ caseId: 'case-1', output: '该方法在 10 个样本下可能提高稳定性。' })])
  expect(outputs.filter((row: any) => row.status === 'failed')).toHaveLength(3)
  expect(JSON.parse(await readFile(join(dir, 'blind-review.json'), 'utf8'))).toHaveLength(1)
  expect(result.state.status).toBe('incomplete')
  expect(result.budget.knownUsd).toBeGreaterThan(0)
  expect(await verifyCollectionCosts(dir)).toBe('unknown')
})
it('collects baseline/candidate and independent review through the real gateway and accounts for all calls', async () => {
  const dir = await directory(); const bodies: any[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); bodies.push(body)
    let content: string
    if (body.messages[0].content.startsWith('You independently review')) content = JSON.stringify(JSON.parse(body.messages[1].content).paragraphs.map((p: any) => ({ paragraphId: p.paragraphId, issues: [] })))
    else {
      const user = body.messages[1].content; const marker = '## Here is the input:'
      const inputs = JSON.parse(user.slice(user.lastIndexOf(marker) + marker.length).trim())
      content = JSON.stringify(inputs.map((p: any) => ({ id: p.id, output: '该方法在 10 个样本下可能提高稳定性。' })))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 30 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const report = await collectTranslationAcceptance(cases, system.replaceAll('\n', '\r\n'), dir, { settings: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test', qps: 20 }, apiKey: 'test-only', budgetUsd: 1, prices: { hit: .01, miss: .1, output: .2 }, maxInputTokens: 4096, maxOutputTokens: 4096 })
  expect(bodies).toHaveLength(3)
  expect(bodies.map(body => body.max_tokens)).toEqual([4096, 4096, 4096])
  expect(report.budget.knownUsd).toBeCloseTo(.000048)
  const material = JSON.parse(await readFile(join(dir, 'blind-review.json'), 'utf8'))
  const privateData = JSON.parse(await readFile(join(dir, 'blind-private.json'), 'utf8'))
  expect(privateData.salt).toMatch(/^[a-f0-9]{64}$/)
  const keys = JSON.parse(await readFile(join(dir, 'blind-key.json'), 'utf8'))
  for (const key of keys) expect(key.blindId).not.toBe(createHash('sha256').update(JSON.stringify(['translation-acceptance-2026-10-18-v1', key.caseId, key.arm, key.sourceHash, key.outputHash])).digest('hex').slice(0, 32))
  expect(material).toHaveLength(2)
  expect(material.every((row: any) => row.status === 'pending')).toBe(true)
  expect(report.acceptance.ready).toBe(false)
  expect(report.acceptance.denominators.candidate.humanReviewed).toBe(0)
  expect((await readFile(join(dir, 'diagnostics', 'paper-1', 'candidate', 'paper-1-candidate.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  expect(await verifyCollectionCosts(dir)).toBe('known')
  const ledgerPath = join(dir, 'budget-ledger.json')
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
  await writeFile(ledgerPath, JSON.stringify({ ...ledger, knownUsd: 0 }))
  expect(await verifyCollectionCosts(dir)).toBe('unknown')
})
it('stops further planned batches after an independent reviewer HTTP failure while retaining translations', async () => {
  const dir = await directory(); let calls = 0
  const samples = Array.from({ length: 6 }, (_, index) => ({ ...cases[0], id: `case-${index + 1}` }))
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); calls++
    const review = body.messages[0].content.startsWith('You independently review')
    const marker = '## Here is the input:'
    const user = body.messages[1].content
    const content = review ? '' : JSON.stringify(JSON.parse(user.slice(user.lastIndexOf(marker) + marker.length)).map((p: any) => ({ id: p.id, output: '该方法在 10 个样本下可能提高稳定性。' })))
    res.writeHead(review ? 503 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 30 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const report = await collectTranslationAcceptance(samples, system, dir, { settings: { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test', qps: 20 }, apiKey: 'test-only', budgetUsd: 1, prices: { hit: .01, miss: .1, output: .2 }, maxInputTokens: 8192, maxOutputTokens: 4096 })
  expect(calls).toBe(3)
  expect(report.state.status).toBe('incomplete')
  expect(report.state.error).toContain('503')
  expect(report.budget.unknownRequests).toBe(0)
  const outputs = JSON.parse(await readFile(join(dir, 'outputs.json'), 'utf8'))
  expect(outputs.filter((row: any) => row.status === 'completed')).toHaveLength(10)
})
