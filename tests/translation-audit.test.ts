import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationAudit } from '../src/main/translation-audit'
import { stableMessages } from '../src/main/translation-prompts'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'audit-context-')); directories.push(directory)
  return { directory, audit: new TranslationAudit({ directory, documentId: 'paper', policy: 'policy', sampleRate: 1 }) }
}
const reply = (content: string) => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content } }] } })
it('keeps distinct review IDs for repeated unlocated paragraphs and includes complete source context', async () => {
  const { audit } = await setup(); let request: any
  const source = 'The treatment group may differ.'
  const body = { messages: stableMessages([{ role: 'user', content: `You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nJSON.\n## Here is the input:\n${JSON.stringify([{ id: 0, input: 'K means the treatment group.' }, { id: 1, input: source }, { id: 2, input: source }])}` }]) }
  await audit.observe(body, reply(JSON.stringify([{ id: 0, output: 'K 表示治疗组。' }, { id: 1, output: '治疗组可能不同。' }, { id: 2, output: '治疗组可能不同。' }])), async body => {
    request = JSON.parse(body.messages[1].content)
    return JSON.stringify(request.paragraphs.map((paragraph: any) => ({ paragraphId: paragraph.paragraphId, issues: [] })))
  })
  expect(new Set(request.paragraphs.map((paragraph: any) => paragraph.paragraphId)).size).toBe(3)
  expect(request.sourceContext).toHaveLength(3)
  expect(request.sourceContext[0].input).toBe('K means the treatment group.')
})
it('passes single fallback glossary/context to the independent reviewer', async () => {
  const { audit } = await setup(); let context = ''
  const body = { messages: stableMessages([{ role: 'user', content: 'You are a professional zh translator.\n## Rules\nTranslate.\n## Context / Hints\nK is the gain.\n## Glossary\n| Source Term | Target Term |\n| --- | --- |\n| bounded | 有界 |\n## Output\nPlain text.\nNow translate the following text:\nIt may remain bounded.' }]) }
  await audit.observe(body, reply('它可能保持有界。'), async body => {
    const payload = JSON.parse(body.messages[1].content); context = payload.context
    return JSON.stringify(payload.paragraphs.map((paragraph: any) => ({ paragraphId: paragraph.paragraphId, issues: [] })))
  })
  expect(context).toContain('K is the gain.')
  expect(context).toContain('bounded | 有界')
})
it('records supplied glossary provenance and scoped conflicts without assuming user authorship', async () => {
  const { directory, audit } = await setup()
  const body = { messages: stableMessages([{ role: 'user', content: 'You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nJSON.\n## Contextual Hints for Better Translation\nThe most recent title is: Results\n## Glossary Tables\n### Glossary: auto_extracted\n| Source Term | Target Term |\n| --- | --- |\n| ABC | 自适应边界校正 |\n## Here is the input:\n[{"id":0,"input":"ABC is defined as adaptive boundary correction."}]' }]) }
  await audit.observe(body, reply('[{"id":0,"output":"ABC 被定义为自适应边界校正。"}]'), async body => JSON.stringify(JSON.parse(body.messages[1].content).paragraphs.map((p: any) => ({ paragraphId: p.paragraphId, issues: [] }))))
  const glossary = JSON.parse(await readFile(join(directory, 'translation-glossary.json'), 'utf8'))
  expect(glossary.entries[0]).toMatchObject({ src: 'ABC', tgt: '自适应边界校正', origin: 'supplied', preferred: false, definitionQuote: 'ABC is defined as adaptive boundary correction.' })
})
