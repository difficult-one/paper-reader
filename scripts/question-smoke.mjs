import { _electron as electron } from 'playwright'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

const root = resolve('output/playwright', process.env.PAPER_READER_EXECUTABLE ? 'packaged-questions' : 'questions'); await mkdir(root, { recursive: true })
const fixture = resolve(root, 'question-paper.pdf')
const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica)
for (let page = 1; page <= 4; page++) {
  const p = pdf.addPage([600, 800])
  p.drawText(page === 2 ? 'ABC (adaptive boundary correction) adjusts boundaries.' : 'ABC improves scientific reading under specific conditions.', { x: 45, y: 740, size: 14, font })
  for (let line = 0; line < 22; line++) p.drawText(`Research methods and limitations. Page ${page}, paragraph ${line}.`, { x: 45, y: 690 - line * 24, size: 11, font })
}
await writeFile(fixture, await pdf.save())
const chinese = await PDFDocument.create(); const chinesePage = chinese.addPage([600, 800])
const chineseText = '边界校正方法用于调整识别结果的边界，并受到实验条件限制。'
const cid = chinese.context.register(chinese.context.obj({ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'STSong-Light', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 4 } }))
const cidFont = chinese.context.register(chinese.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light', Encoding: 'UniGB-UCS2-H', DescendantFonts: [cid] }))
chinesePage.node.set(PDFName.of('Resources'), chinese.context.obj({ Font: { F1: cidFont } }))
chinesePage.node.addContentStream(chinese.context.register(chinese.context.flateStream(`BT /F1 16 Tf 40 700 Td <${Array.from(chineseText).map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}> Tj ET`)))
const chinesePath = resolve(root, '中文论文.pdf'); await writeFile(chinesePath, await chinese.save())
let calls = 0; let mode = 'normal'; let disconnected = false; let lastPayload
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') { console.log('Unexpected request method:', req.method, req.url); res.writeHead(404); res.end(); return }
  let raw = ''; for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  lastPayload = body
  if (!body.stream) { console.log('Unexpected non-stream request:', JSON.stringify({ url: req.url, messages: body.messages?.map(m => m.content.slice(0, 100)) })); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"choices":[{"message":{"content":"connected"},"finish_reason":"stop"}]}'); return }
  calls++
  assert.equal(body.model, 'question-smoke-model'); assert.equal(body.stream, true)
  assert(!raw.includes('apiKey')); assert(!body.tools)
  if (mode === '429') { res.writeHead(429); res.end('{"error":{"message":"rate limited"}}'); return }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const delta = content => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
  delta('论文明确陈述：ABC 表示自适应边界校正。')
  if (mode === 'hold') { const timer = setInterval(() => delta(' 仍需结合论文的适用条件核对。'), 40); res.on('close', () => { disconnected = true; clearInterval(timer) }); return }
  await new Promise(resolve => setTimeout(resolve, 90))
  delta('本文语境：它用于调整边界，效果受条件限制。[S1] 背景解释：这不是普遍保证。[S999]')
  res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}\n\ndata: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const executablePath = process.env.PAPER_READER_EXECUTABLE
const app = await electron.launch({ ...(executablePath ? { executablePath: resolve(executablePath) } : {}), args: [...(executablePath ? [] : ['.']), fixture, `--data-dir=${resolve(root, `profile-${Date.now()}`)}`], env })
try {
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', error => errors.push(error.message))
  const scrollProfile = () => page.evaluate(async () => {
    const pane = document.querySelector('[data-side="left"] .pdf-scroll'); const start = pane.scrollTop; const frames = []
    let last = performance.now()
    for (let i = 0; i < 100; i++) { await new Promise(requestAnimationFrame); const now = performance.now(); frames.push(now - last); last = now; pane.scrollTop += i < 50 ? 6 : -6 }
    pane.scrollTop = start; frames.sort((a, b) => a - b)
    return { p95Ms: frames[Math.floor(frames.length * .95)], maxMs: frames.at(-1) }
  })
  await page.locator('[data-side="left"] .textLayer span').first().waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '翻译设置', exact: true }).click()
  await page.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`)
  await page.getByLabel('API 密钥', { exact: true }).fill('question-smoke-only')
  await page.getByLabel('模型名称', { exact: true }).fill('question-smoke-model')
  await page.getByLabel('每秒请求数').selectOption('8')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  const select = async () => {
    await page.locator('[data-side="left"] [data-page="1"] .textLayer span').first().evaluate(element => {
      element.closest('.pdf-scroll').focus({ preventScroll: true })
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByTestId('selection-toolbar').waitFor()
  }
  await select()
  await page.locator('[data-side="left"] [data-page="1"] .textLayer span').first().evaluate(element => {
    const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, 3)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '询问选中文字', exact: true }).waitFor({ timeout: 2000 })
  await page.screenshot({ path: resolve(root, 'selection-ask.png') })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '询问选中文字', exact: true }).click()
  assert.equal(await page.locator('.question-selection blockquote').innerText(), 'ABC')
  assert.equal(calls, 0)
  await page.getByRole('button', { name: '关闭问答侧栏' }).click()
  await select()
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '询问选中文字', exact: true }).click()
  assert.match(await page.locator('.question-selection blockquote').innerText(), /ABC improves scientific reading/)
  await page.getByRole('button', { name: '关闭问答侧栏' }).click()
  await select()
  await page.keyboard.press('Alt+q')
  await page.getByRole('complementary', { name: '论文问答侧栏' }).waitFor()
  assert.equal(calls, 0, 'opening/selection must not call the provider')
  const panelOpen = await page.evaluate(async () => {
    const samples = []
    for (let i = 0; i < 12; i++) {
      document.querySelector('[aria-label="关闭问答侧栏"]').click(); await new Promise(requestAnimationFrame)
      const start = performance.now(); document.querySelector('button[aria-label="论文问答"]').click(); await new Promise(requestAnimationFrame)
      if (document.querySelector('.question-panel').getBoundingClientRect().width < 340) throw new Error('question panel did not open')
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b); return { samples, p95Ms: samples[Math.floor(samples.length * .95)] }
  })
  assert(panelOpen.p95Ms < 100, 'opening the panel should respond locally within 100ms at P95')
  await page.getByText(/选区及相关论文片段/).first().waitFor()
  const scrollBaseline = await scrollProfile()
  await page.getByRole('button', { name: '解释术语', exact: true }).click()
  await page.getByText('回答包含未核实的出处', { exact: false }).waitFor({ timeout: 30000 })
  assert.equal(calls, 1)
  assert.equal(await page.locator('.question-answer [data-citation="S999"]').count(), 0)
  await page.locator('.question-answer [data-citation="S1"]').click()
  await page.getByRole('button', { name: '复制回答', exact: true }).click()
  await page.getByText('已复制回答', { exact: true }).waitFor()
  await page.getByRole('button', { name: '保存为备注', exact: true }).click()
  await page.getByText('已保存为新备注', { exact: true }).waitFor()
  await page.getByLabel('追问或输入问题').fill('解释得更详细')
  await page.getByLabel('追问或输入问题').press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.question-turn').length === 2 && !document.querySelector('[aria-label="停止生成"]'))
  await page.screenshot({ path: resolve(root, 'question-wide.png') })
  await page.getByRole('button', { name: '关闭问答侧栏' }).click()
  await page.getByRole('button', { name: '论文问答', exact: true }).click()
  await page.getByLabel('问答会话', { exact: true }).selectOption({ index: 1 })
  await page.getByLabel('追问或输入问题').fill('继续解释，请保留部分回答')
  mode = 'hold'; await page.getByLabel('追问或输入问题').press('Enter')
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor()
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.question-answer')).at(-1)?.textContent.includes('ABC'))
  const scrollDuringGeneration = await scrollProfile()
  assert(scrollDuringGeneration.p95Ms < Math.max(50, scrollBaseline.p95Ms * 1.5), 'question streaming should preserve responsive PDF scrolling')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await page.getByText('已停止生成。', { exact: false }).waitFor()
  for (let i = 0; i < 100 && !disconnected; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert(disconnected, 'stop must cancel upstream')
  const beforeRetry = calls; mode = '429'
  await page.getByRole('button', { name: '重试此问题', exact: true }).last().click()
  await page.getByText(/HTTP 429/).waitFor()
  await page.waitForTimeout(400); assert.equal(calls, beforeRetry + 1, 'no automatic retries')
  await app.browserWindow(page).then(window => window.evaluate(window => window.setSize(1000, 780)))
  await page.screenshot({ path: resolve(root, 'question-narrow.png') })
  const layout = await page.evaluate(() => {
    const panel = document.querySelector('.question-panel').getBoundingClientRect(); const reader = document.querySelector('.reading-workspace').getBoundingClientRect()
    return { panel: panel.width, reader: reader.width, overflow: document.documentElement.scrollWidth > innerWidth }
  })
  assert(layout.panel >= 340 && layout.panel <= 420); assert(layout.reader >= 600); assert(!layout.overflow)
  await page.getByLabel('追问或输入问题').press('Escape')
  await page.getByRole('complementary', { name: '论文问答侧栏' }).waitFor({ state: 'hidden' })
  mode = 'hold'
  await page.getByRole('button', { name: '论文问答', exact: true }).click()
  await page.getByLabel('追问或输入问题').fill('换一个选区时停止这个请求')
  await page.getByLabel('追问或输入问题').press('Enter')
  await page.getByRole('button', { name: '停止生成', exact: true }).waitFor()
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.question-answer')).at(-1)?.textContent.includes('ABC'))
  await page.getByRole('button', { name: '关闭问答侧栏' }).click()
  await select()
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '询问选中文字', exact: true }).click()
  await page.getByLabel('问答会话', { exact: true }).selectOption({ index: 1 })
  await page.waitForFunction(() => document.querySelector('.question-turn:last-child .question-error')?.textContent.includes('已停止'))
  await page.getByRole('button', { name: '关闭问答侧栏' }).click()
  await page.getByRole('button', { name: '导入中英对照', exact: true }).click()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, chinesePath)
  await page.getByRole('dialog').getByRole('button', { name: '选择中文 PDF', exact: true }).click()
  await page.getByRole('button', { name: '开始对照阅读', exact: true }).click()
  await page.locator('[data-side="right"] .textLayer').filter({ hasText: '边界校正' }).waitFor({ timeout: 30000 })
  await page.locator('[data-side="right"] .textLayer span').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    getSelection().removeAllRanges(); getSelection().addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByTestId('selection-toolbar').getByRole('button', { name: '询问选中文字', exact: true }).click()
  assert.match(await page.locator('.question-selection').innerText(), /依据中文版本/)
  mode = 'normal'; await page.getByRole('button', { name: '解释这句话', exact: true }).click()
  await page.getByText('回答包含未核实的出处', { exact: false }).waitFor()
  const chineseEvidence = JSON.parse(lastPayload.messages[1].content)
  assert(chineseEvidence.selection.includes('边界校正'))
  assert(chineseEvidence.evidence.every(e => !e.text.includes('ABC')))
  const chineseCitation = page.locator('.question-answer [data-citation="S1"]')
  assert.match(await chineseCitation.innerText(), /中文版本/)
  await chineseCitation.click()
  await page.screenshot({ path: resolve(root, 'question-chinese.png') })
  const verticalLayout = await page.evaluate(() => {
    const body = document.querySelector('.reader-body').getBoundingClientRect()
    const controls = ['.question-composer textarea', '.question-send-row', '.question-live', '.question-usage'].map(selector => ({ selector, bottom: document.querySelector(selector).getBoundingClientRect().bottom }))
    return { bodyBottom: body.bottom, controls }
  })
  assert(verticalLayout.controls.every(c => c.bottom <= verticalLayout.bodyBottom + 1), `question controls must fit inside the reader: ${JSON.stringify(verticalLayout)}`)
  await app.browserWindow(page).then(window => window.evaluate(window => window.setSize(1000, 680)))
  await page.waitForTimeout(80)
  const minimumLayout = await page.evaluate(() => ({ bodyBottom: document.querySelector('.reader-body').getBoundingClientRect().bottom, controlsBottom: document.querySelector('.question-usage').getBoundingClientRect().bottom }))
  assert(minimumLayout.controlsBottom <= minimumLayout.bodyBottom + 1, 'Send, status and usage must fit at the supported minimum window height')
  await page.screenshot({ path: resolve(root, 'question-minimum.png') })
  await page.getByRole('button', { name: '删除当前问答会话', exact: true }).click()
  assert.equal(await page.locator('.question-turn').count(), 0)
  const preservedNotes = await page.evaluate(async path => {
    const doc = await window.reader.openPdf(path); return window.reader.annotations(doc.value.id)
  }, fixture)
  assert.equal(preservedNotes.value.length, 1, 'deleting question history must preserve the explicitly saved note')
  assert.equal(errors.length, 0, errors.join('\n'))
  await writeFile(resolve(root, 'report.json'), JSON.stringify({ providerCalls: calls, cancellationPropagated: disconnected, layout, verticalLayout, minimumLayout, panelOpen, scrollBaseline, scrollDuringGeneration, chineseSelection: true, chineseVersionIsolation: true, rendererErrors: errors, qualityEvaluation: 'Synthetic provider; human factual accuracy and citation support targets not measured.' }, null, 2))
  console.log('Question smoke passed:', JSON.stringify({ calls, layout }))
} finally { await app.close(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
