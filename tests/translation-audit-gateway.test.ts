import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startTranslationGateway } from '../src/main/translation-gateway'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const source = 'The treatment group had 10 events and control had 20 events.'
const translated = '治疗组有 20 起事件，对照组有 10 起事件。'
async function setup(malformed = false, numericRepair = false, scoped = true, partial = false) {
  const directory = await mkdtemp(join(tmpdir(), 'translation-audit-')); closes.push(() => rm(directory, { recursive: true, force: true }))
  const calls: any[] = []
  const server: Server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); calls.push(body)
    const review = body.messages[0].content.startsWith('You independently review')
    const requested = review ? JSON.parse(body.messages[1].content).paragraphs : []
    const content = review ? malformed ? '[]' : JSON.stringify(requested.map((item: any) => ({ paragraphId: item.paragraphId, issues: [{ category: 'binding', severity: 'critical', sourceQuote: 'treatment group had 10 events', translationQuote: '治疗组有 20 起事件', issue: '组别数值被交换。' }] }))) : JSON.stringify([{ id: 0, output: numericRepair && calls.length === 1 ? translated.replace('20', '200') : translated }])
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 30 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); closes.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const settings = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test', apiKey: 'private-test-key', qps: 20 }
  const gateway = await startTranslationGateway({ settings, cacheDir: join(directory, 'cache'), ...(scoped ? { documentFingerprint: 'paper' } : {}), quality: { directory: join(directory, 'qa'), sampleRate: 0 } })
  closes.push(() => gateway.close())
  const send = () => fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ messages: [{ role: 'user', content: `You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nJSON.\n## Here is the input:\n${JSON.stringify([{ id: 0, input: source }, ...(partial ? [{ id: 1, input: 'The estimate may remain bounded.' }] : [])])}` }] }) })
  return { gateway, directory, calls, send }
}
it('runs a separate evidenced review, preserves translation schema, counts cost and avoids duplicate review', async () => {
  const { gateway, directory, calls, send } = await setup()
  expect(JSON.parse((await (await send()).json()).choices[0].message.content)).toEqual([{ id: 0, output: translated }])
  await send(); await gateway.close()
  expect(calls).toHaveLength(2)
  expect(calls[1].thinking).toBeUndefined()
  expect(calls[1].reasoning_effort).toBeUndefined()
  expect(gateway.stats.requests).toBe(2)
  expect(gateway.stats.completionTokens).toBe(60)
  const report = JSON.parse(await readFile(join(directory, 'qa', 'translation-quality-report.json'), 'utf8'))
  expect(report.issues[0]).toMatchObject({ category: 'binding', severity: 'critical', status: 'unresolved', page: null })
  expect(report.paragraphs[0].semanticStatus).toBe('unresolved')
  const diagnostic = await readFile(gateway.diagnosticsFile, 'utf8')
  expect(diagnostic).not.toContain(source)
  expect(diagnostic).not.toContain('private-test-key')
  const reviewLog = diagnostic.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(entry => entry.phase === 'semantic-review')
  expect(reviewLog.outcome).toBe('completed')
})
it('keeps successful siblings structurally passed and reviewable when the aggregate batch fails', async () => {
  const { gateway, directory, calls, send } = await setup(false, false, true, true)
  expect((await send()).status).toBe(422)
  await gateway.close()
  const report = JSON.parse(await readFile(join(directory, 'qa', 'translation-quality-report.json'), 'utf8'))
  expect(report.summary).toMatchObject({ total: 2, structuralPassed: 1, modelReviewed: 1 })
  expect(report.paragraphs.find((row: any) => row.source === source)).toMatchObject({ output: translated, structuralStatus: 'passed' })
  expect(report.paragraphs.find((row: any) => row.source !== source).structuralStatus).toBe('failed')
  expect(calls.some(body => body.messages[0].content.startsWith('You independently review'))).toBe(true)
})
it('does not confuse an invalid independent review with a semantic pass', async () => {
  const { directory, send, gateway } = await setup(true)
  expect((await send()).ok).toBe(true); await gateway.close()
  const report = JSON.parse(await readFile(join(directory, 'qa', 'translation-quality-report.json'), 'utf8'))
  expect(report.paragraphs[0]).toMatchObject({ semanticStatus: 'pending', reviewMethod: 'model-incomplete' })
})
it('repairs invalid numeric output once without injecting another provider’s thinking fields', async () => {
  const { gateway, calls, send } = await setup(false, true)
  expect((await send()).ok).toBe(true)
  expect(calls).toHaveLength(3)
  expect(calls[1].thinking).toBeUndefined()
  expect(calls[1].reasoning_effort).toBeUndefined()
  expect(gateway.stats.qualityRepairRequests).toBe(1)
  expect(gateway.stats.semanticReviewRequests).toBe(1)
})
it('a report write failure never turns a valid translation cache hit into another paid request', async () => {
  const { gateway, directory, calls, send } = await setup(false, false, false)
  await writeFile(join(directory, 'qa'), 'path is unavailable')
  try {
    expect((await send()).status).toBe(502)
    const count = calls.length
    expect((await send()).status).toBe(502)
    expect(calls).toHaveLength(count)
  } finally { await rm(join(directory, 'qa')) }
  await gateway.close()
})
