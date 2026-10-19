import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTranslationGateway } from '../src/main/translation-gateway'
import { parseBatch } from '../src/main/paragraph-cache'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const prompt = (source = '[{"id":0,"input":"20 samples"},{"id":1,"input":"p < 0.05 {v1}"}]') => ({ messages: [{ role: 'user', content: `You are a professional zh native translator.\n\n## Structure Rules\nKeep IDs and formulas.\n\n## Output Format\nReturn JSON.\n\n## Contextual Hints for Better Translation\nPaper: Trial\n\n## Here is the input:\n${source}` }] })
const reply = (outputs: any, reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: JSON.stringify(outputs) } }], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 } }))
async function setup(respond: (body: any, index: number) => Response | Promise<Response>) {
  const dir = await mkdtemp(join(tmpdir(), 'reader-economy-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const native = globalThis.fetch; const bodies: any[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).startsWith('https://api.deepseek.com/')) { const body = JSON.parse(String(init?.body)); bodies.push(body); return Promise.resolve(respond(body, bodies.length)) }
    return native(input, init)
  })
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'local-test', qps: 2, translationMode: 'economy' as const }
  const gateway = await startTranslationGateway({ settings, cacheDir: dir, documentFingerprint: 'paper', taskId: 'test' }); cleanups.push(() => gateway.close())
  const send = (body = prompt()) => fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(body) })
  return { gateway, bodies, send, settings, dir }
}
it('数值损坏只升级错误条目一次，保留完整上下文、已通过译文和两次用量', async () => {
  const { send, bodies, gateway } = await setup((_body, i) => i === 1 ? reply([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p > 0.05 {v1}' }]) : reply([{ id: 1, output: 'p < 0.05 {v1}' }]))
  const response = await send(); expect(response.ok).toBe(true)
  expect(JSON.parse((await response.json()).choices[0].message.content)).toEqual([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p < 0.05 {v1}' }])
  expect(bodies.map(b => b.reasoning_effort)).toEqual(['low', 'high'])
  expect(parseBatch(bodies[1])?.paragraphs.map(p => p.id)).toEqual([1])
  expect(bodies[1].messages[1].content).toContain('Original batch source context')
  expect(bodies[1].messages[1].content).toContain('20 samples')
  expect(gateway.stats.requests).toBe(2); expect(gateway.stats.completionTokens).toBe(60); expect(gateway.stats.qualityRepairRequests).toBe(1)
  await send(); expect(bodies).toHaveLength(2)
})
it('重点复译仍失败时，同任务重复请求不继续付费；有效兄弟段落仍保留', async () => {
  const { send, bodies } = await setup(() => reply([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p > 0.05 {v1}' }]))
  expect((await send()).status).toBe(422)
  expect((await send()).status).toBe(422)
  expect((await send(prompt('[{"id":30,"input":"20 samples"},{"id":31,"input":"p < 0.05 {v1}"}]'))).status).toBe(422)
  expect(bodies).toHaveLength(2)
})
it('截断 JSON 不猜测有效段落，进行至多一次完整批次修复', async () => {
  const { send, bodies } = await setup((_b, i) => reply([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p < 0.05 {v1}' }], i === 1 ? 'length' : 'stop'))
  expect((await send()).ok).toBe(true)
  expect(parseBatch(bodies[1])?.paragraphs).toHaveLength(2)
})
it('服务商限流不触发质量升级，保留重试头', async () => {
  const { send, bodies } = await setup(() => new Response('{"error":{"message":"limited"}}', { status: 429, headers: { 'retry-after': '4' } }))
  const response = await send(); expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('4'); expect(bodies).toHaveLength(1)
})
it('手动低思考与保真省钱不交叉复用缓存', async () => {
  const { send, bodies, settings, dir } = await setup(() => reply([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p < 0.05 {v1}' }]))
  await send()
  const manual = await startTranslationGateway({ settings: { ...settings, translationMode: 'manual', reasoningEffort: 'low' }, cacheDir: dir, documentFingerprint: 'paper' }); cleanups.push(() => manual.close())
  await fetch(`${manual.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${manual.token}` }, body: JSON.stringify(prompt()) })
  expect(bodies).toHaveLength(2)
})

it('相同源批次改ID的并发请求等待正在成功的修复，不提前报失败', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve }); let repairing!: () => void; const started = new Promise<void>(resolve => { repairing = resolve })
  const { send, bodies } = await setup(async (_body, i) => {
    if (i === 1) return reply([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p > 0.05 {v1}' }])
    repairing(); await blocked; return reply([{ id: 1, output: 'p < 0.05 {v1}' }])
  })
  const one = send(); await started
  const two = send(prompt('[{"id":8,"input":"20 samples"},{"id":9,"input":"p < 0.05 {v1}"}]'))
  release()
  expect((await Promise.all([one, two])).map(r => r.status)).toEqual([200, 200]); expect(bodies).toHaveLength(2)
})
it('修复限流保留429语义和等待头，同任务不再重复付费', async () => {
  const { send, bodies } = await setup((_body, i) => i === 1 ? reply([{ id: 0, output: '20 个样本' }, { id: 1, output: 'p > 0.05 {v1}' }]) : new Response('{"error":{"message":"limited"}}', { status: 429, headers: { 'retry-after': '4' } }))
  expect((await send()).status).toBe(429)
  const next = await send(); expect(next.status).toBe(429); expect(next.headers.get('retry-after')).toBe('4'); expect(bodies).toHaveLength(2)
})
it('未知模板仍持久缓存；相同请求不重复收费', async () => {
  const { send, bodies } = await setup(() => new Response('{"choices":[{"finish_reason":"stop","message":{"content":"已连接"}}]}'))
  const input = { messages: [{ role: 'user', content: 'Unknown status request' }] }
  await send(input); await send(input); expect(bodies).toHaveLength(1)
})
it('自动重点复译遵守实际发送QPS，术语数值变化也需修复', async () => {
  const times: number[] = []
  const { send, bodies } = await setup((_body, i) => { times.push(performance.now()); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify([{ src: '10-Hz stimulation', tgt: i === 1 ? '100-Hz刺激' : '10-Hz刺激' }]) } }] })) })
  const input = { messages: [{ role: 'user', content: 'You are an expert multilingual terminologist.\n\n### Extraction Rules\nKeep terms.\n\n### Translation Rules\nKeep values.\n\n### Output Format\nJSON.\nInput Text:\n```\n10-Hz stimulation\n```' }] }
  expect((await send(input)).status).toBe(200); expect(bodies.map(b => b.reasoning_effort)).toEqual(['low', 'high']); expect(times[1] - times[0]).toBeGreaterThanOrEqual(440)
})
