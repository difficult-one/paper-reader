// Real bundled BabelDOC, local deterministic service. Verifies layout plumbing only.
import { build } from 'vite'
import { builtinModules } from 'node:module'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const directory = resolve('output/translation-skill-evals/layout-current')
await mkdir(directory, { recursive: true })
const runner = join(directory, 'runner')
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve('src/main/engine.ts'), outDir: runner, emptyOutDir: false, rollupOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: { entryFileNames: 'engine.mjs' } } } })
const { runEngine, inspectPdf } = await import(pathToFileURL(join(runner, 'engine.mjs')).href)
const calls = { translations: 0, terminology: 0, semanticReview: 0 }
const replacements = { Attention: '注意力', Abstract: '摘要', Introduction: '引言', Conclusion: '结论', Conclusions: '结论', References: '参考文献', Figure: '图', Table: '表', Encoder: '编码器', Decoder: '解码器', Training: '训练', Results: '结果', Experiments: '实验', Implementation: '实现', Architecture: '架构' }
const translated = input => input.replace(/\b(Attention|Abstract|Introduction|Conclusion|Conclusions|References|Figure|Table|Encoder|Decoder|Training|Results|Experiments|Implementation|Architecture)\b/g, word => replacements[word])
const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const system = body.messages.find(message => message.role === 'system')?.content ?? ''
    const user = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
    let content
    if (system.startsWith('You independently review')) {
      calls.semanticReview++
      content = JSON.stringify(JSON.parse(user).paragraphs.map(paragraph => ({ paragraphId: paragraph.paragraphId, issues: [] })))
    } else if (system.trimStart().startsWith('You are an expert multilingual terminologist.')) { calls.terminology++; content = '[]' }
    else if (user.includes('## Here is the input:')) {
      calls.translations++
      const marker = '## Here is the input:'
      const inputs = JSON.parse(user.slice(user.lastIndexOf(marker) + marker.length).trim())
      content = JSON.stringify(inputs.map(item => ({ id: item.id, output: translated(item.input) })))
    } else {
      calls.translations++
      const marker = 'Now translate the following text:'
      content = translated(user.includes(marker) ? user.slice(user.lastIndexOf(marker) + marker.length).trim() : user)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 30, total_tokens: 130 } }))
  } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(error) } })) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const controller = new AbortController(); process.once('SIGINT', () => controller.abort())
try {
  for (const fixture of args.length ? args : ['attention']) {
    if (!['attention', 'resnet'].includes(fixture)) throw new Error('Use only the local attention or resnet fixtures')
    const input = resolve(`output/playwright/${fixture}.pdf`)
    const outputDir = join(directory, `${fixture}-${Date.now()}`)
    await mkdir(outputDir, { recursive: true })
    console.log(`Starting bundled engine: ${fixture}; local simulated translations; zero paid calls`)
    const output = await runEngine({ command: { executable: resolve('resources/runtime/pdf2zh/runtime/python.exe'), prefixArgs: [resolve('resources/reader_engine.py'), resolve('resources/runtime/pdf2zh')] }, input, outputDir, homeDir: join(directory, 'engine-home'), settings: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-layout-only', model: 'layout-fixture-only', qps: 8 }, signal: controller.signal, onLine: line => { appendFileSync(join(outputDir, 'engine.log'), line + '\n'); if (/\bERROR\b|质量报告/.test(line)) console.log(line) } })
    const info = await inspectPdf(output)
    const report = JSON.parse(await readFile(join(outputDir, 'translation-quality-report.json'), 'utf8'))
    console.log(JSON.stringify({ fixture, output, pages: info.pages, calls, structuralSummary: report.summary, layout: report.layout.status, paidCalls: 0, semanticQuality: 'not-measured-local-fixture' }))
  }
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
