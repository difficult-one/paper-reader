import { afterEach, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareTranslationRequest, startTranslationGateway } from '../src/main/translation-gateway'
import { describePrefix } from '../src/main/cache-diagnostics'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const success = (content = '翻译结果') => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 64, completion_tokens_details: { reasoning_tokens: 0 } } })
async function setup(reply: (body: any) => any = () => success(), status = 200, headers: Record<string, string> = {}, gatewayOptions: { coldStart?: { enabled: boolean; minPrefixBytes?: number }; signal?: AbortSignal; documentFingerprint?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reader-api-')); cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const bodies: any[] = []
  const server: Server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    expect(req.headers.authorization).toBe('Bearer upstream-secret')
    expect(req.url).toBe('/v1/chat/completions')
    const body = JSON.parse(raw); bodies.push(body)
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(await reply(body)))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  const settings = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', apiKey: 'upstream-secret', qps: 2 }
  const gateway = await startTranslationGateway({ settings, cacheDir: dir, ...gatewayOptions }); cleanups.push(() => gateway.close())
  const send = (body: object = { model: 'test-model', messages: [{ role: 'user', content: 'Translate hello.' }] }, key = gateway.token) => fetch(`${gateway.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { dir, settings, gateway, send, bodies }
}

it('官方 DeepSeek 的三档始终保留思考，其他兼容服务不被注入专用参数', () => {
  const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'Translate hello.' }] }
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'secret', qps: 2 }
  const prepared = prepareTranslationRequest(body, settings)
  expect(prepared.thinking).toEqual({ type: 'enabled' })
  expect(prepared.reasoning_effort).toBe('high')
  expect(prepared.max_tokens).toBeUndefined()
  for (const level of ['low', 'high', 'max'] as const) {
    const request = prepareTranslationRequest(body, { ...settings, reasoningEffort: level })
    expect(request.thinking).toEqual({ type: 'enabled' })
    expect(request.reasoning_effort).toBe(level)
  }
  expect(prepareTranslationRequest(body, { ...settings, baseUrl: 'https://example.com/v1' }).thinking).toBeUndefined()
})

it('默认保留标准思考和服务商的输出预算', () => {
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'secret', qps: 2 }
  const body = prepareTranslationRequest({ messages: [{ role: 'user', content: 'Translate a complex sentence.' }] }, settings)
  expect(body.thinking).toEqual({ type: 'enabled' })
  expect(body.max_tokens).toBeUndefined()
})

it('显式保真省钱仅在官方已知模板使用轻度思考，不删规则或限制输出', () => {
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'secret', qps: 2, translationMode: 'economy' as const }
  const body = { messages: [{ role: 'user', content: `${rules}\n\n## Here is the input:\n[{"id":0,"input":"20 samples"}]` }] }
  const prepared = prepareTranslationRequest(body, settings)
  expect(prepared.reasoning_effort).toBe('low')
  expect(prepared.thinking).toEqual({ type: 'enabled' })
  expect(prepared.max_tokens).toBeUndefined()
  expect(prepared.messages[0].content).toContain('Research translation quality')
  expect(prepareTranslationRequest({ messages: [{ role: 'user', content: 'Unknown request' }] }, settings).reasoning_effort).toBe('high')
})

const rules = 'You are a professional zh native translator.\n\n## Structure Rules\nKeep paragraph IDs and count.\n\n## Do NOT Modify\nKeep {v1} and <style> tags.\n\n## Output Format\nReturn a JSON array.\n\n## Style\nPreserve meaning.'
it('批翻译规则前缀跨标题保持一致，正文、术语规则与占位符完整保留', () => {
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'secret', qps: 2 }
  const one = `${rules}\n\n## Contextual Hints for Better Translation\nFirst title: One\n\n## Here is the input:\n[{"id":0,"input":"{v1} first"}]`
  const two = `${rules.replace('## Output Format', '## Glossary\nAlways use the exact target term.\n\n## Output Format')}\n\n## Contextual Hints for Better Translation\nFirst title: Two\n\n## Glossary Tables\n|sample|样本|\n\n## Here is the input:\n[{"id":0,"input":"second"}]`
  const a = prepareTranslationRequest({ messages: [{ role: 'user', content: one }] }, settings)
  const b = prepareTranslationRequest({ messages: [{ role: 'user', content: two }] }, settings)
  expect(a.messages[0]).toEqual(b.messages[0])
  expect(a.messages[0].role).toBe('system')
  expect(a.messages[0].content).toContain('Keep {v1} and <style> tags.')
  expect(a.messages[1].content).toContain('{"id":0,"input":"{v1} first"}')
  expect(b.messages[1].content).toContain('Always use the exact target term.')
  expect(b.messages[1].content).toContain('|sample|样本|')
  expect(b.messages[1].content).toContain('First title: Two')
})

it('同一请求第二次使用磁盘缓存；重启网关后仍不调用上游', async () => {
  const { gateway, settings, dir, bodies, send } = await setup()
  expect((await (await send()).json()).choices[0].message.content).toBe('翻译结果')
  await send(); expect(bodies).toHaveLength(1)
  expect(gateway.stats.localCacheHits).toBe(1)
  expect(gateway.stats.requests).toBe(1)
  expect(gateway.stats.promptTokens).toBe(100)
  expect(gateway.stats.cachedPromptTokens).toBe(64)
  expect(gateway.stats.cacheUsageReported).toBe(true)
  expect(gateway.stats.reasoningUsageReported).toBe(true)
  expect(gateway.stats.completionElapsedMs).toBeGreaterThan(0)
  const elapsedBeforeCache = gateway.stats.completionElapsedMs
  await send()
  expect(gateway.stats.completionElapsedMs).toBe(elapsedBeforeCache)
  expect(gateway.stats.completionTokens).toBe(30)
  const next = await startTranslationGateway({ settings, cacheDir: dir }); cleanups.push(() => next.close())
  await fetch(`${next.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${next.token}` }, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'Translate hello.' }] }) })
  expect(bodies).toHaveLength(1)
  expect(next.stats.localCacheHits).toBe(1)
})

it('同时出现的相同请求合并，不重复扣费', async () => {
  let release!: () => void; const block = new Promise<void>(resolve => { release = resolve })
  const { send, bodies, gateway } = await setup(async () => { await block; return success() })
  const first = send(); const second = send()
  try { await new Promise(resolve => setTimeout(resolve, 30)) } finally { release() }
  const responses = await Promise.all([first, second]); expect(responses.every(r => r.ok)).toBe(true)
  expect(bodies).toHaveLength(1); expect(gateway.stats.localCacheHits).toBe(1)
})

it('changed extraction boundaries invalidate scoped requests and paragraph reuse', async () => {
  const { send, settings, dir, bodies } = await setup(() => success('[{"id":0,"output":"普通正文。"}]'), 200, {}, { documentFingerprint: 'paper' })
  const body = { messages: [{ role: 'user', content: `${rules}\n\n## Here is the input:\n[{"id":0,"input":"Plain paragraph."}]` }] }
  await send(body)
  const next = await startTranslationGateway({ settings, cacheDir: dir, documentFingerprint: 'paper', extractionVersion: 'changed-boundaries' }); cleanups.push(() => next.close())
  await fetch(`${next.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${next.token}` }, body: JSON.stringify(body) })
  expect(bodies).toHaveLength(2)
})

it('截断回复不能写入成功缓存', async () => {
  const { send, bodies } = await setup(() => ({ ...success(), choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }))
  await send(); await send(); expect(bodies).toHaveLength(2)
})

it('批翻译漏段或返回错误 ID 时，不能缓存为成功结果', async () => {
  const { send, bodies } = await setup(() => success('[{"id":99,"output":"错误段落"}]'))
  const body = { messages: [{ role: 'user', content: `${rules}\n\n## Here is the input:\n[{"id":0,"input":"first"},{"id":1,"input":"second"}]` }] }
  await send(body); await send(body); expect(bodies).toHaveLength(2)
})

it('空回复不能写入成功缓存', async () => {
  const { send, bodies, gateway } = await setup(() => success(''))
  await send(); await send(); expect(bodies).toHaveLength(2)
  expect(gateway.stats.localCacheHits).toBe(0)
})

it('服务商未提供缓存或思考明细时，标为未知而非零用量', async () => {
  const { send, gateway } = await setup(() => ({ choices: success().choices, usage: { prompt_tokens: 100, completion_tokens: 30 } }))
  await send()
  expect(gateway.stats.usageReported).toBe(true)
  expect(gateway.stats.cacheUsageReported).toBe(false)
  expect(gateway.stats.reasoningUsageReported).toBe(false)
})

it('只有输入用量的响应不参与输出速率耗时统计', async () => {
  const { send, gateway } = await setup(() => ({ choices: success().choices, usage: { prompt_tokens: 100 } }))
  await send()
  expect(gateway.stats.completionElapsedMs).toBe(0)
})

it('空白段落译文不能持久化，否则会永久重放引擎拒绝的回复', async () => {
  const { send, bodies } = await setup(() => success('[{"id":0,"output":"  "}]'))
  const body = { messages: [{ role: 'user', content: `${rules}\n\n## Here is the input:\n[{"id":0,"input":"Nonempty paragraph."}]` }] }
  await send(body); await send(body); expect(bodies).toHaveLength(2)
})

it('保留服务商的限流等待头，避免 SDK 过早重试', async () => {
  const { send, bodies } = await setup(() => ({ error: { message: 'rate limited' } }), 429, { 'Retry-After': '60', 'retry-after-ms': '60000' })
  const response = await send()
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(response.headers.get('retry-after-ms')).toBe('60000')
  await send(); expect(bodies).toHaveLength(2)
})

it('拒绝未经授权的本地请求，且不同模型不会共用缓存', async () => {
  const { send, bodies, settings, dir } = await setup()
  expect((await send({}, 'wrong-token')).status).toBe(401); expect(bodies).toHaveLength(0)
  await send()
  const next = await startTranslationGateway({ settings: { ...settings, model: 'other-model' }, cacheDir: dir }); cleanups.push(() => next.close())
  const other = await fetch(`${next.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${next.token}` }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Translate hello.' }] }) })
  expect(other.ok).toBe(true); expect(bodies).toHaveLength(2)
  expect(bodies[1].model).toBe('other-model')
})

it('术语规则的变化不打断相同标题的请求前缀，输入 JSON 表示保持确定', () => {
  const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const prepare = (glossary: string, input: string) => prepareTranslationRequest({ messages: [{ role: 'user', content: `${rules.replace('## Output Format', `${glossary}## Output Format`)}\n\n## Contextual Hints for Better Translation\nFirst title: Shared title\n\n## Here is the input:\n${input}` }] }, settings)
  const a = prepare('', '[{"id":0,"input":"first","layout_label":"text"}]')
  const b = prepare('## Glossary\nUse these exact terms.\n\n', '[{"input":"second","layout_label":"text","id":0}]')
  expect(a.messages[0]).toEqual(b.messages[0])
  expect(a.messages[1].content.split('## Here is the input:')[0].trim()).toBe('## Contextual Hints for Better Translation\nFirst title: Shared title')
  expect(b.messages[1].content.startsWith('## Contextual Hints for Better Translation\nFirst title: Shared title')).toBe(true)
  expect(b.messages[1].content).toContain('Use these exact terms.')
  expect(b.messages[1].content).toContain('[{"id":0,"input":"second","layout_label":"text"}]')
})

const termPrompt = (reference: string, text: string) => `\nYou are an expert multilingual terminologist. Extract key terms from the text and translate them into zh.\n\n### Extraction Rules\nKeep key terms.\n\n### Translation Rules\nUse the reference glossary.\n\n${reference}\n\n### Output Format\nReturn ONLY a valid JSON array.\n\n### Example\n[{"src":"LLM","tgt":"大语言模型"}]\n\nInput Text:\n\`\`\`\n${text}\n\`\`\`\n\nReturn JSON ONLY. NO OTHER TEXT.\nResult:\n`
it('术语提取把可变参考表后移，保留所有规则、示例与输入', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const a = prepareTranslationRequest({ messages: [{ role: 'user', content: termPrompt('', 'First text') }] }, settings)
  const b = prepareTranslationRequest({ messages: [{ role: 'user', content: termPrompt('Reference Glossaries (for consistency and quality):\n- sample → 样本', 'Second text') }] }, settings)
  expect(a.messages[0].role).toBe('system')
  expect(a.messages[0]).toEqual(b.messages[0])
  expect(a.messages[0].content).toContain('### Output Format')
  expect(a.messages[0].content).toContain('{"src":"LLM","tgt":"大语言模型"}')
  expect(b.messages[1].content).toContain('sample → 样本')
  expect(b.messages[1].content).toContain('Second text')
  expect(b.messages[1].content).toContain('Return JSON ONLY. NO OTHER TEXT.')
})

it('单段翻译固定指令前移，未知消息不改动', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const prefix = ';; Treat next line as plain text input and translate it into zh, output translation ONLY. NO explanations. NO notes. Input:\n\n'
  const input = [{ role: 'system', content: 'You are a professional,authentic machine translation engine.' }, { role: 'user', content: `${prefix}A {v1} sentence.` }]
  const request = prepareTranslationRequest({ messages: input }, settings)
  expect(request.messages[0].content).toContain(prefix.trim())
  expect(request.messages[1].content).toBe('A {v1} sentence.')
  const unknown = [{ role: 'user', content: 'A custom prompt\n## Here is the input:\n[]' }]
  expect(prepareTranslationRequest({ messages: unknown }, settings).messages).toEqual(unknown)
})

it('科研规则应用于真实批模板，同时保留结构、公式与可变上下文', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const input = '[{"id":0,"input":"The controller may reduce torque ripple by 5%. {v1}","layout_label":"text"}]'
  const request = prepareTranslationRequest({ messages: [{ role: 'user', content: `${rules}\n\n## Here is the input:\n${input}` }] }, settings)
  expect(request.messages[0].content).toContain('Preserve negation')
  expect(request.messages[0].content).toContain('bibliography entries')
  expect(request.messages[0].content).toContain('source data')
  expect(request.messages[1].content).toContain(input)
})

const fallbackPrompt = 'You are a professional zh native translator who needs to fluently translate text into zh.\n\nFollow all rules strictly.\n\n## Rules\nKeep tags and {v1} unchanged.\n\n## Glossary\n| torque | 转矩 |\n\n## Context / Hints\nThe first title is: Motor Control\n\n## Output\nOutput ONLY the translated zh text.\n\nNow translate the following text:\n\n<style id="1">The torque may decrease by 5%.</style> {v1}'
it('BabelDOC 单段回退同样应用科研规范并保留术语与公式上下文', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const result = prepareTranslationRequest({ messages: [{ role: 'user', content: fallbackPrompt }] }, settings)
  expect(result.messages[0].role).toBe('system')
  expect(result.messages[0].content).toContain('Preserve negation')
  expect(result.messages[0].content).toContain('Output ONLY the translated zh text.')
  expect(result.messages[1].content).toContain('| torque | 转矩 |')
  expect(result.messages[1].content).toContain('<style id="1">The torque may decrease by 5%.</style> {v1}')
})
it('新科研规范不能复用旧的单段回退缓存', async () => {
  const { send, bodies, dir, settings } = await setup(() => success('新规范译文'))
  const body = { model: 'test-model', messages: [{ role: 'user', content: fallbackPrompt }] }
  const key = createHash('sha256').update(JSON.stringify([settings.baseUrl, body, 'reader-api-v1'])).digest('hex')
  await writeFile(join(dir, `${key}.json`), JSON.stringify({ version: 1, body: success('旧回退译文') }))
  expect((await (await send(body)).json()).choices[0].message.content).toBe('新规范译文')
  expect(bodies).toHaveLength(1)
})

it('对象键及批正文 JSON 缩进差异不会产生重复上游请求', async () => {
  const { send, bodies, gateway } = await setup(() => success('[{"id":0,"output":"译文"}]'))
  await send({ temperature: 0, messages: [{ role: 'user', content: `${rules}\n\n## Here is the input:\n[{"id":0,"input":"same"}]` }], model: 'ignored' })
  await send({ messages: [{ content: `${rules}\n\n## Here is the input:\n[\n {"input": "same", "id": 0}\n]`, role: 'user' }], temperature: 0, model: 'ignored' })
  expect(bodies).toHaveLength(1)
  expect(gateway.stats.localCacheHits).toBe(1)
})

it('已有 v1 请求缓存仍能读取', async () => {
  const { send, bodies, dir, settings } = await setup()
  const body = { model: 'test-model', messages: [{ role: 'user', content: 'Translate hello.' }] }
  const key = createHash('sha256').update(JSON.stringify([settings.baseUrl, body, 'reader-api-v1'])).digest('hex')
  await writeFile(join(dir, `${key}.json`), JSON.stringify({ version: 1, body: success('旧缓存译文') }))
  expect((await (await send()).json()).choices[0].message.content).toBe('旧缓存译文')
  expect(bodies).toHaveLength(0)
})

it('术语提取的无效 JSON 不能被缓存，但合法空数组可以复用', async () => {
  let content = 'This is not JSON'
  const { send, bodies } = await setup(() => success(content))
  const body = { messages: [{ role: 'user', content: termPrompt('', 'Sample text') }] }
  await send(body); await send(body); expect(bodies).toHaveLength(2)
  content = '[]'
  await send(body); await send(body); expect(bodies).toHaveLength(3)
})

it('合并中的错误请求不冒充成功的本地命中', async () => {
  let release!: () => void; const block = new Promise<void>(resolve => { release = resolve })
  const { send, gateway } = await setup(async () => { await block; return { error: { message: 'rate limited' } } }, 429)
  const first = send(); const second = send()
  await new Promise(resolve => setTimeout(resolve, 30)); release()
  const responses = await Promise.all([first, second])
  expect(responses.map(response => response.status)).toEqual([429, 429])
  expect(gateway.stats.localCacheHits).toBe(0)
})

it('缓存分母只使用同一批有效 H/M 样本，原始 miss 与推算 miss 分开保存', async () => {
  const samples = [
    { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
    { prompt_tokens: 900 },
    { prompt_tokens: 200, prompt_cache_hit_tokens: 100 },
    { prompt_tokens: 100, prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 30 }
  ]
  const { send, gateway } = await setup(() => ({ choices: success().choices, usage: samples.shift() }))
  for (let i = 0; i < 4; i++) await send({ messages: [{ role: 'user', content: `Translate ${i}.` }] })
  expect(gateway.stats.cache).toMatchObject({ samples: 2, estimatedSamples: 1, hitTokens: 160, missTokens: 140, rawMissTokens: 70, missingSamples: 1, anomalousSamples: 1 })
  expect(gateway.stats.promptTokens).toBe(1300)
  // The invalid 90/30 sample and missing 900-token sample do not distort 160 / 300.
  expect(gateway.stats.cache!.hitTokens / (gateway.stats.cache!.hitTokens + gateway.stats.cache!.missTokens)).toBeCloseTo(160 / 300)
})

it('失败重试逐次计量，任务日志只保存指纹且本地命中没有伪造的服务商 usage', async () => {
  let attempts = 0
  const { send, gateway } = await setup(() => ++attempts === 1 ? { error: { message: 'temporary' } } : success())
  const body = { messages: [{ role: 'user', content: 'private-paper-text' }] }
  await send(body); await send(body)
  const local = await (await send(body)).json()
  expect(local.reader_local_cache_hit).toBe(true)
  expect(local.usage).toBeUndefined()
  await gateway.close()
  const raw = await readFile(gateway.diagnosticsFile, 'utf8')
  const records = raw.trim().split('\n').map(line => JSON.parse(line))
  expect(records.filter(record => record.source === 'remote').map(record => record.attempt)).toEqual([1, 2])
  expect(records[0]).toMatchObject({ outcome: 'error', usage: { promptTokens: null, hitTokens: null, missTokens: null } })
  expect(records.at(-1)).toMatchObject({ source: 'request-cache', outcome: 'completed' })
  expect(raw).not.toContain('private-paper-text')
  expect(raw).not.toContain('upstream-secret')
  expect(raw).not.toContain('翻译结果')
  expect(gateway.stats.cache?.missingSamples).toBe(1)
})

it('非有限或负数 usage 标为异常而非有效零值', async () => {
  const { send, gateway } = await setup(() => ({ choices: success().choices, usage: { prompt_tokens: 10, prompt_cache_hit_tokens: -1, prompt_cache_miss_tokens: 11 } }))
  await send()
  expect(gateway.stats.cache).toMatchObject({ samples: 0, anomalousSamples: 1 })
  expect(gateway.stats.cacheUsageReported).toBe(false)
})

it('单段回退的标题位于变化术语之前，新增术语和公式提示仍完整参与翻译', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const prepare = (prompt: string) => prepareTranslationRequest({ messages: [{ role: 'user', content: prompt }] }, settings)
  const a = prepare(fallbackPrompt)
  const b = prepare(fallbackPrompt.replace('| torque | 转矩 |', '| torque | 转矩 |\n| ripple | 脉动 |'))
  expect(a.messages[1].content.indexOf('Motor Control')).toBeLessThan(a.messages[1].content.indexOf('## Glossary'))
  expect(describePrefix(a).fixedPrefixFingerprint).toBe(describePrefix(b).fixedPrefixFingerprint)
  expect(describePrefix(a).glossaryFingerprint).not.toBe(describePrefix(b).glossaryFingerprint)
  expect(b.messages[1].content).toContain('| ripple | 脉动 |')
  expect(b.messages[1].content).toContain('{v1}')
})

it('只改批正文及临时 ID 时固定区不变，三类模板独立诊断', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const prepare = (text: string) => prepareTranslationRequest({ messages: [{ role: 'user', content: text }] }, settings)
  const first = prepare(`${rules}\n\n## Contextual Hints for Better Translation\nFirst title: Shared\n\n## Here is the input:\n[{"id":0,"input":"A {v1}"}]`)
  const second = prepare(`${rules}\n\n## Contextual Hints for Better Translation\nFirst title: Shared\n\n## Here is the input:\n[{"id":99,"input":"B {v2}"}]`)
  expect(describePrefix(first).fixedPrefixFingerprint).toBe(describePrefix(second).fixedPrefixFingerprint)
  expect(describePrefix(first).type).toBe('batch')
  expect(describePrefix(prepare(termPrompt('', 'terms'))).type).toBe('terminology')
  expect(describePrefix(prepare(fallbackPrompt)).type).toBe('single')
  expect(describePrefix(prepare('Unknown custom prompt')).type).toBe('unknown')
  const changed = prepare(`${rules.replace('Preserve meaning.', 'Preserve precise meaning.')}\n\n## Here is the input:\n[{"id":0,"input":"A"}]`)
  expect(describePrefix(changed).ruleFingerprint).not.toBe(describePrefix(first).ruleFingerprint)
})

it('带有额外协议字段的未知消息不能因模板相似而丢失字段', () => {
  const settings = { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 's', qps: 2 }
  const messages = [{ role: 'user', name: 'custom-role', content: fallbackPrompt }]
  expect(prepareTranslationRequest({ messages }, settings).messages).toEqual(messages)
})

const batchBody = (input: string, context = 'Shared paper') => ({ messages: [{ role: 'user', content: `${rules}\n\n## Contextual Hints for Better Translation\nFirst title: ${context}\n\n## Here is the input:\n${input}` }] })
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
it('实验调度只串行约束同前缀最初两个真实请求，随后恢复并发且没有预热调用', async () => {
  const releases: (() => void)[] = []
  const { send, bodies } = await setup(async body => {
    await new Promise<void>(resolve => { releases.push(resolve) })
    const input = JSON.parse(body.messages[1].content.split('## Here is the input:')[1])
    return { ...success(JSON.stringify(input.map((item: any) => ({ id: item.id, output: `译文${item.input}` })))), usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } }
  }, 200, {}, { coldStart: { enabled: true, minPrefixBytes: 0 } })
  const requests = Array.from({ length: 4 }, (_, i) => send(batchBody(JSON.stringify([{ id: i, input: `p${i}` }]))))
  try {
    await waitUntil(() => releases.length >= 1); await new Promise(resolve => setTimeout(resolve, 30))
    expect(bodies).toHaveLength(1)
    releases[0]()
    await waitUntil(() => releases.length >= 2); await new Promise(resolve => setTimeout(resolve, 30))
    expect(bodies).toHaveLength(2)
    releases[1]()
    await waitUntil(() => releases.length >= 4)
    releases[2](); releases[3]()
    expect((await Promise.all(requests)).every(response => response.ok)).toBe(true)
    expect(bodies).toHaveLength(4)
  } finally { for (const release of releases) release(); await Promise.allSettled(requests) }
})

it('冷启动等待按前缀隔离，取消释放等待和在途请求', async () => {
  const controller = new AbortController(); let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const { send, bodies, gateway } = await setup(async () => { await blocked; return success('[{"id":0,"output":"译文"}]') }, 200, {}, { coldStart: { enabled: true, minPrefixBytes: 0 }, signal: controller.signal })
  const one = send(batchBody('[{"id":0,"input":"one"}]'))
  await waitUntil(() => bodies.length === 1)
  const two = send(batchBody('[{"id":0,"input":"two"}]'))
  const other = send(batchBody('[{"id":0,"input":"three"}]', 'Other paper'))
  try {
    await waitUntil(() => bodies.length === 2)
    controller.abort()
    expect((await Promise.all([one, two, other])).map(response => response.status)).toEqual([502, 502, 502])
    await gateway.close()
    expect(bodies).toHaveLength(2)
  } finally { controller.abort(); release(); await Promise.allSettled([one, two, other]) }
})

const remoteParagraphs = (body: any): { id: string | number; input: string }[] => JSON.parse(body.messages[1].content.split('## Here is the input:')[1])
const echoBatch = (body: any) => success(JSON.stringify(remoteParagraphs(body).map(item => ({ id: item.id, output: `译:${item.input}` }))))
it('有效源上下文不变时临时 ID 重组保持顺序，重启后仍可逐段复用', async () => {
  const { send, bodies, gateway, settings, dir } = await setup(echoBatch, 200, {}, { documentFingerprint: 'paper-a' })
  await send(batchBody('[{"id":0,"input":"a {v1}"},{"id":1,"input":"b"}]'))
  const partial = await (await send(batchBody('[{"id":"a-new","input":"a {v1}"},{"id":"b-new","input":"b"}]'))).json()
  expect(JSON.parse(partial.choices[0].message.content)).toEqual([{ id: 'a-new', output: '译:a {v1}' }, { id: 'b-new', output: '译:b' }])
  const all = await (await send(batchBody('[{"id":20,"input":"a {v1}"},{"id":21,"input":"b"}]'))).json()
  expect(all.reader_local_cache_hit).toBe(true); expect(all.usage).toBeUndefined()
  expect(JSON.parse(all.choices[0].message.content)).toEqual([{ id: 20, output: '译:a {v1}' }, { id: 21, output: '译:b' }])
  expect(bodies).toHaveLength(1)
  expect(gateway.stats.localParagraphHits).toBe(4)
  await gateway.close()
  const next = await startTranslationGateway({ settings, cacheDir: dir, documentFingerprint: 'paper-a' }); cleanups.push(() => next.close())
  const response = await fetch(`${next.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${next.token}` }, body: JSON.stringify(batchBody('[{"id":90,"input":"a {v1}"},{"id":91,"input":"b"}]')) })
  expect(response.ok).toBe(true); expect(bodies).toHaveLength(1)
})

it('不同批次共享相同上下文段落的在途结果，交叉顺序不会互相等待', async () => {
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve })
  const { send, bodies, gateway } = await setup(async body => { await blocked; return echoBatch(body) }, 200, {}, { documentFingerprint: 'paper-a' })
  const one = send(batchBody('[{"id":0,"input":"a"},{"id":1,"input":"b"}]'))
  await waitUntil(() => bodies.length === 1)
  const two = send(batchBody('[{"id":3,"input":"a"},{"id":4,"input":"b"}]'))
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(bodies.flatMap(remoteParagraphs).map(item => item.input).sort()).toEqual(['a', 'b'])
    release()
    const responses = await Promise.all([one, two])
    expect(responses.every(response => response.ok)).toBe(true)
    expect(JSON.parse((await responses[1].json()).choices[0].message.content)).toEqual([{ id: 3, output: '译:a' }, { id: 4, output: '译:b' }])
    expect(gateway.stats.localParagraphHits).toBe(2)
  } finally { release(); await Promise.allSettled([one, two]) }
})

it('段落上下文、术语、样式、请求参数、论文、思考档位和模型分别失效', async () => {
  const { send, bodies, settings, dir } = await setup(echoBatch, 200, {}, { documentFingerprint: 'paper-a' })
  const body = batchBody('[{"id":0,"input":"a {v1}","layout_label":"text"}]')
  await send(body)
  await send(batchBody('[{"id":8,"input":"a {v1}","layout_label":"text"}]', 'Other section'))
  await send({ messages: [{ role: 'user', content: body.messages[0].content.replace('## Here is the input:', '## Glossary Tables\n| a | 术语 |\n\n## Here is the input:') }] })
  await send(batchBody('[{"id":1,"input":"a {v2}","layout_label":"text"}]'))
  await send({ ...body, temperature: 0.5 })
  for (const variation of [{ documentFingerprint: 'paper-b' }, { settings: { ...settings, model: 'other' } }, { settings: { ...settings, reasoningEffort: 'low' as const } }]) {
    const next = await startTranslationGateway({ cacheDir: dir, settings, documentFingerprint: 'paper-a', ...variation }); cleanups.push(() => next.close())
    await fetch(`${next.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${next.token}` }, body: JSON.stringify(body) })
  }
  expect(bodies).toHaveLength(8)
})

it('缺段回复不能成为完整成功缓存，已校验段落独立保留后仅补齐缺段', async () => {
  let first = true
  const { send, bodies } = await setup(body => {
    if (!first) return echoBatch(body)
    first = false; const [item] = remoteParagraphs(body)
    return success(JSON.stringify([{ id: item.id, output: `译:${item.input}` }]))
  }, 200, {}, { documentFingerprint: 'paper-a' })
  const body = batchBody('[{"id":0,"input":"a"},{"id":1,"input":"b"}]')
  expect((await send(body)).status).toBe(502)
  const completed = await (await send(body)).json()
  expect(remoteParagraphs(bodies[1])).toEqual([{ id: 1, input: 'b' }])
  expect(bodies[1].messages[1].content).toContain('Original batch source context')
  expect(bodies[1].messages[1].content).toContain('"input":"a"')
  expect(JSON.parse(completed.choices[0].message.content)).toHaveLength(2)
})

it.each(['length', 'placeholder', 'empty', 'duplicate-id'])('损坏段落 %s 不被持久化', async failure => {
  const { send, bodies } = await setup(body => {
    const response = echoBatch(body)
    if (failure === 'length') response.choices[0].finish_reason = 'length'
    if (failure === 'placeholder') response.choices[0].message.content = '[{"id":0,"output":"译文丢失公式"}]'
    if (failure === 'empty') response.choices[0].message.content = '[{"id":0,"output":" "}]'
    if (failure === 'duplicate-id') response.choices[0].message.content = '[{"id":0,"output":"译:{v1}"},{"id":0,"output":"译:{v1}"}]'
    return response
  }, 200, {}, { documentFingerprint: 'paper-a' })
  const body = batchBody('[{"id":0,"input":"{v1}"}]')
  expect((await send(body)).status).toBe(502)
  expect((await send(body)).status).toBe(502)
  expect(bodies).toHaveLength(2)
})

it('共享段落的远端失败不计作本地复用，并保留 429 等待头', async () => {
  let release!: () => void; const block = new Promise<void>(resolve => { release = resolve })
  const { send, bodies, gateway } = await setup(async () => { await block; return { error: { message: 'limited' } } }, 429, { 'retry-after': '12' }, { documentFingerprint: 'paper-a' })
  const one = send(batchBody('[{"id":0,"input":"same"}]'))
  await waitUntil(() => bodies.length === 1)
  const two = send(batchBody('[{"id":9,"input":"same"}]'))
  try {
    await new Promise(resolve => setTimeout(resolve, 30)); release()
    const responses = await Promise.all([one, two])
    expect(responses.map(response => response.status)).toEqual([429, 429])
    expect(responses[1].headers.get('retry-after')).toBe('12')
    expect(gateway.stats.localParagraphHits).toBe(0)
    expect(gateway.stats.localCacheHits).toBe(0)
  } finally { release(); await Promise.allSettled([one, two]) }
})

it('整请求缓存同样拒绝损坏的样式和单段回退公式', async () => {
  const { send, bodies } = await setup(() => success('缺少占位符的译文'))
  const body = { messages: [{ role: 'user', content: fallbackPrompt }] }
  await send(body); await send(body)
  expect(bodies).toHaveLength(2)
})

it('完整样式片段可随中文语序移动，但交叉嵌套仍被拒绝', async () => {
  let output = "它是<style id='2'>昨天</style><style id='1'>精心</style>设计的。"
  const { send, bodies } = await setup(body => success(JSON.stringify([{ id: remoteParagraphs(body)[0].id, output }])), 200, {}, { documentFingerprint: 'paper-a' })
  const input = "It was <style id='1'>carefully</style> designed <style id='2'>yesterday</style>."
  expect((await send(batchBody(JSON.stringify([{ id: 0, input }])))).status).toBe(200)
  expect((await send(batchBody(JSON.stringify([{ id: 9, input }])))).status).toBe(200)
  expect(bodies).toHaveLength(1)
  output = '<style id="1">甲<b>乙</style></b>'
  expect((await send(batchBody(JSON.stringify([{ id: 0, input: '<style id="1">A<b>B</b></style>' }])))).status).toBe(502)
  output = '<style id="1">甲<style id="2">乙</style></style>'
  expect((await send(batchBody(JSON.stringify([{ id: 0, input: '<style id="1">A</style><style id="2">B</style>' }])))).status).toBe(502)
})

it('相同句子的邻段语境变化会失效，不能将河岸译文用于银行语境', async () => {
  const { send, bodies } = await setup(body => {
    const paragraphs = remoteParagraphs(body)
    const lender = paragraphs.some(item => item.input.includes('lender'))
    return success(JSON.stringify(paragraphs.map(item => ({ id: item.id, output: item.input.includes('bank') ? lender ? '银行不稳定。' : '河岸不稳定。' : '背景。' }))))
  }, 200, {}, { documentFingerprint: 'paper-a' })
  await send(batchBody('[{"id":0,"input":"The river flooded."},{"id":1,"input":"The bank was unstable."}]'))
  const second = await (await send(batchBody('[{"id":8,"input":"The lender failed."},{"id":9,"input":"The bank was unstable."}]'))).json()
  expect(remoteParagraphs(bodies[1])).toHaveLength(2)
  expect(JSON.parse(second.choices[0].message.content)[1].output).toBe('银行不稳定。')
})

it('冷启动释放后仍遵守实际上游 QPS，不将积压请求同时发出', async () => {
  const starts: number[] = []
  const { send } = await setup(async body => {
    starts.push(performance.now())
    if (starts.length === 1) await new Promise(resolve => setTimeout(resolve, 600))
    return { ...echoBatch(body), usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } }
  }, 200, {}, { coldStart: { enabled: true, minPrefixBytes: 0 } })
  const requests = Array.from({ length: 4 }, (_, i) => send(batchBody(JSON.stringify([{ id: i, input: String(i) }]))))
  await Promise.all(requests)
  expect(starts).toHaveLength(4)
  for (let index = 1; index < starts.length; index++) expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(470)
})

it('源文包含输入标记时，部分恢复仍按实际段落区校验和记录状态', async () => {
  let first = true
  const { send, gateway } = await setup(body => {
    const input = JSON.parse(body.messages[1].content.slice(body.messages[1].content.lastIndexOf('\n## Here is the input:') + '\n## Here is the input:'.length))
    const output = (first ? input.slice(0, 1) : input).map((item: any) => ({ id: item.id, output: `译:${item.input}` }))
    first = false; return success(JSON.stringify(output))
  }, 200, {}, { documentFingerprint: 'paper-a' })
  const body = batchBody('[{"id":0,"input":"Quoted marker ## Here is the input: is source text."},{"id":1,"input":"second"}]')
  expect((await send(body)).status).toBe(502)
  expect((await send(body)).status).toBe(200)
  await gateway.close()
  const summary = JSON.parse(await readFile(gateway.diagnosticsSummaryFile, 'utf8'))
  expect(summary.byType.batch).toMatchObject({ completed: 1, errors: 1 })
})
