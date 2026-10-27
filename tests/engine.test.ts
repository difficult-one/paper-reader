import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { inspectPdf, runEngine, testConnection } from '../src/main/engine'

const temporary: string[] = []
let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'reader-中文 ')); temporary.push(dir)
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  document.addPage().drawText('A scientific paper for a bilingual reader.', { font, x: 30, y: 500 })
  const input = join(dir, '英文 paper.pdf'); await writeFile(input, await document.save())
  return { dir, input }
}
const settings = { baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'test-secret-private', qps: 1 }
function command(mode: string) { return { executable: process.execPath, prefixArgs: [resolve('tests/fixtures/engine.cjs'), mode] } }

describe('本地翻译进程', () => {
  it('解析实际 PDF，并拒绝损坏文件', async () => {
    const { dir, input } = await fixture()
    expect(await inspectPdf(input)).toEqual({ pages: 1, hasText: true, language: 'en' })
    const bad = join(dir, 'bad.pdf'); await writeFile(bad, 'not a pdf')
    await expect(inspectPdf(bad)).rejects.toThrow()
  })
  it('文字为空的 PDF 会被识别为需要 OCR', async () => {
    const { dir } = await fixture(); const pdf = await PDFDocument.create(); pdf.addPage()
    const input = join(dir, 'scan.pdf'); await writeFile(input, await pdf.save())
    expect((await inspectPdf(input)).hasText).toBe(false)
  })
  it('中文空格路径可以完成翻译；日志隐藏密钥，原文件不变', async () => {
    const { dir, input } = await fixture(); const original = await readFile(input); const logs: string[] = []
    const output = await runEngine({ command: command('success'), input, outputDir: join(dir, 'output'), settings, onLine: s => logs.push(s) })
    expect((await inspectPdf(output)).pages).toBe(1)
    expect(await readFile(input)).toEqual(original)
    expect(logs.join('\n')).not.toContain(settings.apiKey)
    const report = JSON.parse(await readFile(join(dir, 'output', 'translation-quality-report.json'), 'utf8'))
    expect(report.layout).toMatchObject({ status: 'structure-passed', visualReview: 'pending' })
    expect(report.outputVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(report.coverageStatus).toBe('unobserved')
    expect(JSON.parse(await readFile(join(dir, 'output', 'translation-source-index.json'), 'utf8')).pages).toHaveLength(1)
  })
  it('即使退出码为零，没有有效译文也不能报告成功', async () => {
    const { dir, input } = await fixture()
    await expect(runEngine({ command: command('empty'), input, outputDir: join(dir, 'output'), settings })).rejects.toThrow(/译文/)
  })
  it('损坏的输出不会成为可复用译文', async () => {
    const { dir, input } = await fixture()
    await expect(runEngine({ command: command('invalid'), input, outputDir: join(dir, 'output'), settings })).rejects.toThrow(/PDF|译文/)
  })
  it('取消任务会终止真实子进程并以取消状态结束', async () => {
    const { dir, input } = await fixture(); const controller = new AbortController()
    const running = runEngine({ command: command('slow'), input, outputDir: join(dir, 'output'), settings, signal: controller.signal, onLine: () => controller.abort() })
    await expect(running).rejects.toThrow(/取消/)
  })
  it('引擎内部限流重试后成功时，不把重试警告误判为最终失败', async () => {
    const { dir, input } = await fixture()
    const output = await runEngine({ command: command('recovered'), input, outputDir: join(dir, 'output'), settings })
    expect((await inspectPdf(output)).pages).toBe(1)
  })
  it('正常扫描检测阶段的名称不把后续翻译错误误报为扫描件', async () => {
    const { dir, input } = await fixture()
    await expect(runEngine({ command: command('fatal'), input, outputDir: join(dir, 'output'), settings })).rejects.toThrow(/invalid numbers/)
  })
  it('子进程使用独立用户目录，不读取宿主 PDF2ZH 配置', async () => {
    const { dir, input } = await fixture(); const outputDir = join(dir, 'output')
    await runEngine({ command: command('audit'), input, outputDir, settings, homeDir: join(dir, 'engine-home') })
    const audit = JSON.parse(await readFile(join(outputDir, 'audit.json'), 'utf8'))
    expect(audit.profile).toBe(join(dir, 'engine-home'))
    expect(audit.args[audit.args.indexOf('--pool-max-workers') + 1]).toBe('8')
    expect(audit.args[audit.args.indexOf('--openai-base-url') + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(audit.key).not.toBe(settings.apiKey)
  })
})

describe('API 连接测试', () => {
  let receivedMessages: unknown
  async function serve(status: number) {
    server = createServer(async (request, response) => {
      let data = ''; for await (const part of request) data += part
      const body = JSON.parse(data)
      receivedMessages = body.messages
      if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer test-secret-private' || body.model !== 'test-model') {
        response.writeHead(400); response.end(); return
      }
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: '连接成功' } }] } : { error: { message: 'unauthorized' } }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server!.address(); if (!address || typeof address === 'string') throw new Error('server')
    return { ...settings, baseUrl: `http://127.0.0.1:${address.port}/v1` }
  }
  it('实际发送兼容 Chat Completions 请求并检查回复', async () => {
    expect(await testConnection(await serve(200))).toContain('成功')
    expect(receivedMessages).toEqual([{ role: 'user', content: '请回复：连接成功。' }])
  })
  it('密钥错误和限流转换为可理解的错误', async () => {
    await expect(testConnection(await serve(401))).rejects.toThrow(/密钥/)
  })
})
