import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTranslationGateway } from '../src/main/translation-gateway'
import { parseBatch } from '../src/main/paragraph-cache'
import type { TranslationStrategy } from '../src/main/translation-strategy'
const closes: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const terms = (text: string) => ({ messages: [{ role: 'user', content: `You are an expert multilingual terminologist.\n### Extraction Rules\nExtract nouns.\n### Translation Rules\nKeep meanings.\n### Output Format\nJSON src/tgt.\nInput Text:\n\x60\x60\x60\n${text}\n\x60\x60\x60` }] })
const batch = (text = 'It did not increase with 20 samples.') => ({ messages: [{ role: 'user', content: `You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nJSON.\n## Here is the input:\n${JSON.stringify([{ id: 0, input: 'The rotor rotates smoothly.' }, { id: 1, input: text }])}` }] })
async function setup(strategy: TranslationStrategy, respond: (body: any, index: number) => any) {
  const dir = await mkdtemp(join(tmpdir(), 'reader-strategy-')); closes.push(() => rm(dir, { recursive: true, force: true }))
  const native = fetch; const bodies: any[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (String(url).startsWith('https://api.deepseek.com/')) {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(respond(body, bodies.length)) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } } })))
    }
    return native(url, init)
  })
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'test', qps: 8, translationMode: 'economy' as const }
  const gateway = await startTranslationGateway({ settings, cacheDir: dir, documentFingerprint: 'doc', strategy }); closes.push(() => gateway.close())
  const send = (body: object) => fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(body) })
  return { gateway, bodies, send, dir, settings }
}
it('术语文档复用接入网关：相同批次零远端，新章节只提取本章源文', async () => {
  const { send, bodies, gateway } = await setup('terminology', body => body.messages[1].content.includes('Torque') ? [{ src: 'Torque', tgt: '转矩' }] : [{ src: 'Rotor flux', tgt: '转子磁通' }])
  const a = 'Rotor flux is defined as magnetic flux.'
  await send(terms(a))
  const response = await send(terms('Torque means rotational force.'))
  expect(JSON.parse((await response.json()).choices[0].message.content)).toEqual([{ src: 'Torque', tgt: '转矩' }])
  expect(bodies[1].messages[1].content).not.toContain(a)
  await send(terms(a)); expect(bodies).toHaveLength(2)
  expect(gateway.stats.localCacheHits).toBe(1)
})
it('风险正文定向 High 复核，只复核风险段并保留原批上下文，结果再重开零远端', async () => {
  const { send, bodies, gateway } = await setup('adaptive', body => parseBatch(body)!.paragraphs.map(p => ({ id: p.id, output: p.id === 0 ? '转子平稳旋转。' : '在 20 个样本下没有增加。' })))
  expect((await send(batch())).ok).toBe(true)
  expect(bodies).toHaveLength(2)
  expect(bodies[1].reasoning_effort).toBe('high'); expect(bodies[1].thinking).toEqual({ type: 'enabled' })
  expect(parseBatch(bodies[1])!.paragraphs.map(p => p.id)).toEqual([1])
  expect(bodies[1].messages[1].content).toContain('The rotor rotates smoothly.')
  await send(batch()); expect(bodies).toHaveLength(2)
  expect(gateway.stats.semanticReviewRequests).toBe(1)
  expect(gateway.stats.paragraphs).toMatchObject({ total: 4, reused: 2 })
  await gateway.close()
  const report = JSON.parse(await readFile(gateway.diagnosticsSummaryFile, 'utf8'))
  expect(report.byPhase['semantic-review'].remoteAttempts).toBe(1)
})
it('高风险段复核失败至多升级一次，不把初次结构通过误当语义通过', async () => {
  const { send, bodies } = await setup('adaptive', (_body, index) => index === 1 ? [{ id: 0, output: '转子平稳旋转。' }, { id: 1, output: '在 20 个样本下没有增加。' }] : [{ id: 1, output: '在 200 个样本下没有增加。' }])
  expect((await send(batch())).status).toBe(422)
  expect((await send(batch())).status).toBe(422)
  expect(bodies).toHaveLength(2)
})
