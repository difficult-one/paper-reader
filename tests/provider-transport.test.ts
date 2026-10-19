import { afterEach, expect, it } from 'vitest'
import { createServer, type Server, type RequestListener } from 'node:http'
import { ProviderBudget, providerStream, usageFromProvider } from '../src/main/provider-transport'
import type { ServiceSettings } from '../src/shared/types'
const servers: Server[] = []
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()) }) })
async function server(handler: RequestListener) {
  const s = createServer(handler); servers.push(s)
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${(s.address() as { port: number }).port}/v1`, apiKey: 'private-key', model: 'chosen', qps: 100 } satisfies ServiceSettings
}
it('decodes split SSE events and UTF-8, reports usage and preserves selected model', async () => {
  const settings = await server(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    expect(JSON.parse(raw).model).toBe('chosen'); expect(req.headers.authorization).toBe('Bearer private-key')
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const payload = Buffer.from('data: {"choices":[{"delta":{"content":"解释"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" [S1]"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":25,"completion_tokens":8}}\n\ndata: [DONE]\n\n')
    for (let start = 0; start < payload.length; start += 7) res.write(payload.subarray(start, start + 7))
    res.end()
  })
  const chunks: string[] = []
  const result = await providerStream(settings, [{ role: 'user', content: 'Explain.' }], new AbortController().signal, text => chunks.push(text))
  expect(chunks.join('')).toBe('解释 [S1]')
  expect(result).toMatchObject({ finishReason: 'stop', usage: { promptTokens: 25, completionTokens: 8, usageReported: true } })
})
it('does not retry paid errors and redacts keys from provider errors', async () => {
  let calls = 0
  const settings = await server((_req, res) => { calls++; res.writeHead(429); res.end(JSON.stringify({ error: { message: 'private-key rate limit' } })) })
  await expect(providerStream(settings, [{ role: 'user', content: 'Explain.' }], new AbortController().signal, () => {})).rejects.toThrow(/429/)
  expect(calls).toBe(1)
  try { await providerStream(settings, [], new AbortController().signal, () => {}) } catch (e) { expect(String(e)).not.toContain('private-key') }
})
it('shares service concurrency, gives bounded question priority and aborts queued requests', async () => {
  const budget = new ProviderBudget(10000, 1)
  const controller = new AbortController()
  const release = await budget.acquire('translation', controller.signal)
  const order: string[] = []
  const t = budget.acquire('translation', controller.signal).then(done => { order.push('translation'); done() })
  const qs = Array.from({ length: 4 }, (_, i) => budget.acquire('question', controller.signal).then(done => { order.push(`q${i}`); done() }))
  release(); await Promise.all([t, ...qs])
  expect(order.indexOf('translation')).toBeLessThan(4)
  const done = await budget.acquire('translation', controller.signal)
  const cancelled = new AbortController(); const waiting = budget.acquire('question', cancelled.signal); cancelled.abort()
  await expect(waiting).rejects.toBeDefined(); done()
})
it('reports missing usage as unknown, and never counts local reuse as generated tokens', () => {
  expect(usageFromProvider(undefined)).toMatchObject({ usageReported: false, promptTokens: 0, completionTokens: 0 })
})
it('bounds the complete SSE event even when it consists of many short data lines', async () => {
  const settings = await server((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(Array.from({ length: 3000 }, () => `data: ${'x'.repeat(1000)}\n`).join('') + '\n')
  })
  await expect(providerStream(settings, [], new AbortController().signal, () => {})).rejects.toThrow(/过大|超出/)
})
