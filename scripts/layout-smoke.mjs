import { _electron as electron } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

await mkdir('output/playwright', { recursive: true })
let sourcePath = process.argv[2]
if (!sourcePath) {
  // Explicitly synthetic bibliography: no external paper download or API needed.
  const sample = await PDFDocument.create()
  const font = await sample.embedFont(StandardFonts.TimesRoman)
  const page = sample.addPage([595, 842])
  page.drawText('Synthetic numbered-reference layout test', { x: 48, y: 770, size: 15, font })
  page.drawText('References', { x: 48, y: 730, size: 13, font })
  for (let n = 1; n <= 6; n++) {
    const y = 700 - n * 55
    page.drawText(`${n}. Example Author. Synthetic reference may illustrate layout behavior.`, { x: 48, y, size: 11, font })
    page.drawText('This continuation belongs to the same entry. [CrossRef]', { x: 64, y: y - 15, size: 11, font })
  }
  sourcePath = resolve('output/playwright/reference-numbered-fixture.pdf')
  await writeFile(sourcePath, await sample.save())
}
const bytes = new Uint8Array(await readFile(sourcePath))
const loading = getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 })
const doc = await loading.promise
let references = -1
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n)
  const text = (await page.getTextContent()).items.map(i => i.str || '').join(' ')
  if (/\bReferences\b/.test(text)) { references = n - 1; break }
}
assert(references >= 0, 'fixture must have a References heading')
await loading.destroy()
const source = await PDFDocument.load(bytes)
const fixture = await PDFDocument.create()
fixture.addPage((await fixture.copyPages(source, [references]))[0])
const path = resolve('output/playwright/reference-original.pdf')
await writeFile(path, await fixture.save())
const batches = []
const server = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  try {
    const body = JSON.parse(raw)
    const prompt = body.messages.map(m => m.content).join('\n')
    let content = '[]'
    if (body.messages[0]?.content.startsWith('You independently review')) {
      const paragraphs = JSON.parse(body.messages[1].content).paragraphs
      content = JSON.stringify(paragraphs.map(paragraph => ({ paragraphId: paragraph.paragraphId, issues: [] })))
    } else if (prompt.includes('## Here is the input:')) {
      assert(prompt.includes('Research translation quality'))
      const paragraphs = JSON.parse(prompt.split('## Here is the input:').at(-1).trim())
      batches.push(...paragraphs)
      content = JSON.stringify(paragraphs.map(p => ({ id: p.id, output: p.input
        .replaceAll('References', '参考文献（本地模拟翻译）')
        .replaceAll('Recent Advances in the Design, Modeling, and Control of Multiphase Machines', '多相电机设计、建模与控制的最新进展')
        .replaceAll('Current harmonics compensation', '电流谐波补偿')
      })))
    } else if (prompt.includes('Now translate the following text:')) {
      assert(prompt.includes('Research translation quality'))
      content = prompt.slice(prompt.indexOf('Now translate the following text:') + 'Now translate the following text:'.length).trim().replaceAll('References', '参考文献（本地模拟）')
    } else if (prompt.includes(';; Treat next line')) content = body.messages.at(-1).content
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
  } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: { message: String(e) } })) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), path, `--data-dir=${resolve(`output/playwright/layout-profile-${Date.now()}`)}`], env })
try {
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '翻译全文', exact: true }).waitFor({ timeout: 20000 })
  await page.evaluate(async baseUrl => {
    const result = await window.reader.saveSettings({ baseUrl, apiKey: 'local-layout-test', model: 'layout-mock', qps: 8 })
    if (!result.ok) throw new Error(result.error)
  }, `http://127.0.0.1:${server.address().port}/v1`)
  const opened = await page.evaluate(path => window.reader.openPdf(path), path)
  assert(opened.ok)
  const job = await page.evaluate(id => window.reader.startTranslation(id), opened.value.id)
  assert(job.ok)
  await page.getByText('全文翻译完成', { exact: true }).waitFor({ timeout: 180000 }).catch(async error => { console.error(JSON.stringify(await page.evaluate(() => window.reader.currentJob()))); throw error })
  const result = await page.evaluate(() => window.reader.currentJob())
  if (result.value.status !== 'completed') throw new Error(JSON.stringify(result.value))
  const reportPath = result.value.logs.findLast(line => line.startsWith('质量报告已保存：'))?.match(/^质量报告已保存：(.+?)；/)?.[1]
  assert(reportPath, 'the completed job must identify its independent QA report')
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert(report.summary.total >= 3 && report.summary.modelReviewed >= 1, 'risk paragraphs must reach independent semantic review')
  assert.equal(report.summary.unresolved, 0)
  assert.equal(report.layout.visualReview, 'pending')
  assert.match(report.outputVersion, /^[a-f0-9]{64}$/)
  await writeFile('output/playwright/reference-quality-report.json', JSON.stringify(report, null, 2))
  await page.locator('[data-side="right"] .textLayer span').first().waitFor({ timeout: 30000 })
  await page.screenshot({ path: 'output/playwright/reference-layout.png', timeout: 60000 })
  const lines = batches.map(p => ({ label: p.layout_label, input: p.input }))
  await writeFile('output/playwright/reference-batches.json', JSON.stringify(lines, null, 2))
  const numbered = lines.filter(p => /^\s*(?:\[\d+\]|\d+[.)])/.test(p.input.replace(/<[^>]*>/g, '')))
  assert(numbered.length >= 3, 'numbered bibliography entries must reach the model as independent paragraphs')
  const outputLoading = getDocument({ data: new Uint8Array(await readFile(result.value.result.savedTranslationPath)), useSystemFonts: true, verbosity: 0 })
  const output = await outputLoading.promise
  const outputPage = await output.getPage(1)
  const content = await outputPage.getTextContent()
  const markers = content.items.filter(item => /^(?:\[\d+\]|\d+[.)])(?:\s|$)/.test(item.str || '')).map(item => ({ text: item.str, y: item.transform[5] }))
  assert(markers.length >= 3 && new Set(markers.map(m => m.y.toFixed(1))).size === markers.length, 'reference numbers must occupy distinct output lines')
  await outputLoading.destroy()
  console.log(JSON.stringify({ independentEntries: numbered.length, outputNumberLines: markers.length, mockOnly: true, output: result.value.result.savedTranslationPath }))
} finally { await app.close(); await new Promise(resolve => server.close(resolve)) }
