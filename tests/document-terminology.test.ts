import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentTerminology } from '../src/main/document-terminology'
import { stableMessages } from '../src/main/translation-prompts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const body = (source: string) => ({ messages: stableMessages([{ role: 'user', content: `You are an expert multilingual terminologist.\n### Extraction Rules\nExtract nouns.\n### Translation Rules\nKeep ambiguity.\n### Output Format\nJSON src/tgt.\nInput Text:\n\x60\x60\x60\n${source}\n\x60\x60\x60` }]) })
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'reader-terms-')); dirs.push(dir); const scope = { document: 'doc', policy: 'p', model: 'm', service: 'https://example.com', extraction: 'engine-1' }; return { dir, scope, cache: new DocumentTerminology(dir, scope) } }
it('重试已提取批次时复用，新章节只发送本章源文，保留定义与版本出处', async () => {
  const { cache, dir, scope } = await setup()
  const a = 'Rotor flux is defined as the magnetic flux of the rotor.'
  const first = (await cache.plan(body(a)))!
  await cache.commit(first, [{ src: 'Rotor flux', tgt: '转子磁通' }])
  const restarted = new DocumentTerminology(dir, scope)
  const next = (await restarted.plan(body('Torque is defined as rotational force.')))!
  expect(next.reusedTerms).toEqual([])
  expect(next.body.messages[1].content).not.toContain(a)
  expect(next.body.messages[1].content).toContain('Torque is defined')
  const saved = JSON.parse(await readFile(cache.file, 'utf8'))
  expect(saved.version).toBe(1); expect(saved.revision).toBe(1)
  expect(saved.sections[0]).toMatchObject({ source: a, terms: [{ src: 'Rotor flux', tgt: '转子磁通', evidence: a }] })
  expect((await restarted.plan(body(a)))!.complete).toBe(true)
})
it('批次后文影响定义时保留原始完整上下文，不猜测术语到段落的映射', async () => {
  const { cache } = await setup()
  const first = 'Flux denotes this quantity.'
  await cache.commit((await cache.plan(body(first)))!, [{ src: 'Flux', tgt: '磁通' }])
  const source = `${first}\n\nIn this section the quantity is particle flow.`
  const next = (await cache.plan(body(source)))!
  expect(next.complete).toBe(false); expect(next.reusedTerms).toEqual([])
  expect(next.body.messages[1].content).toContain(source)
})
it('新定义不能只因同拼写被跳过或强制合并；空术语结果也有完成标记', async () => {
  const { cache, dir, scope } = await setup()
  await cache.commit((await cache.plan(body('Flux means magnetic flux.')))!, [{ src: 'Flux', tgt: '磁通' }])
  const changed = (await cache.plan(body('Flux means particle flow in this chapter.')))!
  expect(changed.complete).toBe(false); expect(changed.reusedTerms).toEqual([])
  await cache.commit(changed, [{ src: 'Flux', tgt: '通量' }])
  await cache.commit((await cache.plan(body('This is a short introduction.')))!, [])
  expect((await cache.plan(body('This is a short introduction.')))!.complete).toBe(true)
  expect((await new DocumentTerminology(dir, { ...scope, document: 'other' }).plan(body('Flux means magnetic flux.')))!.complete).toBe(false)
})
it('生成参数变化不能误用旧批次，损坏记录回退且并发写入保留所有来源', async () => {
  const { cache, dir, scope } = await setup()
  const a = body('Flux means magnetic flux.')
  await cache.commit((await cache.plan(a))!, [{ src: 'Flux', tgt: '磁通' }])
  expect((await cache.plan({ ...a, temperature: .5 }))!.complete).toBe(false)
  const plans = await Promise.all(['Torque means rotational force.', 'Voltage means potential difference.'].map(source => cache.plan(body(source))))
  await Promise.all(plans.map(plan => cache.commit(plan!, [])))
  expect(JSON.parse(await readFile(cache.file, 'utf8')).sections).toHaveLength(3)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(cache.file, '{broken')
  expect((await new DocumentTerminology(dir, scope).plan(a))!.complete).toBe(false)
})
