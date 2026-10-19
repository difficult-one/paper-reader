import type { AvailableModel, PdfInfo, ProviderSettings, ServiceSettings, TranslationUsage } from '../shared/types'
import { readFile, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { detectLanguage, sanitizeLog, validateProvider, validateSettings } from '../shared/core'
import { prepareTranslationRequest, startTranslationGateway } from './translation-gateway'
import { EXTRACTION_VERSION, LAYOUT_VERSION, TRANSLATION_POLICY_VERSION } from './cache-versions'
import { strategyVersion, type TranslationStrategy } from './translation-strategy'
import { fingerprint } from './cache-diagnostics'
import { extractTranslationSource, inspectTranslationLayout, renderLayoutThumbnails } from './translation-evidence'
import { writeJson } from './store'
export interface RuntimeCommand { executable: string; prefixArgs?: string[] }
export interface EngineOptions { command: RuntimeCommand; input: string; outputDir: string; settings: ServiceSettings; homeDir?: string; taskId?: string; translationPolicyVersion?: string; strategy?: TranslationStrategy; signal?: AbortSignal; onLine?: (line: string) => void; onUsage?: (usage: TranslationUsage) => void }
export async function inspectPdf(path: string): Promise<PdfInfo> {
  const bytes = new Uint8Array(await readFile(path))
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('文件不是有效的 PDF。')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const assets = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))
  const loading = getDocument({ data: bytes, useSystemFonts: true, verbosity: 0, cMapUrl: join(assets, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(assets, 'standard_fonts') + '/' })
  try {
    const doc = await loading.promise
    let hasText = false; let sampleText = ''
    const sample = [...new Set([1, 2, Math.ceil(doc.numPages / 2), doc.numPages])].filter(p => p <= doc.numPages)
    for (const number of sample) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      sampleText += content.items.map(item => 'str' in item ? item.str : '').join(' ')
      if (content.items.some(item => 'str' in item && /[a-zA-Z\u4e00-\u9fff]{2}/.test(item.str))) hasText = true
      page.cleanup()
    }
    return { pages: doc.numPages, hasText, language: detectLanguage(sampleText) }
  } catch (error) {
    if (error instanceof Error && /password/i.test(error.name + error.message)) throw new Error('此 PDF 需要密码，请先解锁后重新打开。')
    throw new Error('PDF 已损坏或无法解析，请尝试重新下载。')
  } finally { await loading.destroy() }
}

function readableError(text: string): string {
  if (/401|403|unauthorized|authentication|invalid.*key/i.test(text)) return 'API 密钥无效或没有访问此模型的权限，请检查翻译设置。'
  if (/429|rate.?limit|quota|insufficient.*balance/i.test(text)) return '翻译服务限流或余额不足，请检查账户或降低每秒请求数后重试。'
  if (/ScannedPDFError|(?:is|appears|detected as|mostly)\s+(?:a\s+)?scanned|scanned\s+(?:pdf|document|file)|(?:requires?|needs?)\s+OCR|no\s+(?:extractable\s+)?text\s+(?:found|detected)/i.test(text)) return '此 PDF 可能是扫描件，请先进行 OCR 文字识别后再翻译。'
  if (/timeout|timed out|connection|connecterror|network|ENOTFOUND|fetch failed/i.test(text)) return '无法连接翻译服务或请求超时，请检查网络和服务地址后重试。'
  return text.slice(-800) || '翻译未能完成，请查看处理记录后重试。'
}

export async function runEngine(options: EngineOptions): Promise<string> {
  const settings = validateSettings(options.settings)
  if (options.signal?.aborted) throw new Error('翻译已取消。')
  await mkdir(options.outputDir, { recursive: true })
  const homeDir = options.homeDir ?? join(dirname(options.outputDir), 'engine-home')
  await mkdir(homeDir, { recursive: true })
  const sourceBytes = await readFile(options.input)
  const documentFingerprint = createHash('sha256').update(sourceBytes).digest('hex')
  const sourceIndex = await extractTranslationSource(new Uint8Array(sourceBytes), documentFingerprint)
  await writeJson(join(options.outputDir, 'translation-source-index.json'), sourceIndex)
  const strategy = options.strategy ?? 'baseline'
  const policy = options.translationPolicyVersion ?? TRANSLATION_POLICY_VERSION
  const gateway = await startTranslationGateway({ settings, cacheDir: join(homeDir, 'reader-api-cache'), documentFingerprint, translationPolicyVersion: policy, strategy, extractionVersion: EXTRACTION_VERSION, diagnosticsDir: join(homeDir, 'cache-diagnostics'), taskId: options.taskId, signal: options.signal, onUsage: options.onUsage, coldStart: { enabled: process.env.PAPER_READER_CACHE_COLD_START === '1' }, quality: { directory: options.outputDir, sourceIndex, cacheDirectory: join(homeDir, 'translation-review-cache'), reviewer: fingerprint([settings.baseUrl, settings.model, 'high']) } })
  try {
  const args = [...(options.command.prefixArgs ?? []), options.input, '--openai', '--openai-model', settings.model,
    '--openai-base-url', gateway.baseUrl, '--lang-in', 'en', '--lang-out', 'zh', '--qps', String(settings.qps),
    '--pool-max-workers', String(Math.min(32, Math.max(8, settings.qps * 4))), '--ignore-cache',
    '--output', options.outputDir, '--no-dual', '--watermark-output-mode', 'no_watermark', '--report-interval', '1']
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PDF2ZH_')))
  Object.assign(env, { USERPROFILE: homeDir, HOME: homeDir, PDF2ZH_OPENAI_API_KEY: gateway.token, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', NO_COLOR: '1', TERM: 'dumb', COLUMNS: '120' })
  const replayScope = fingerprint([documentFingerprint, settings.baseUrl, settings.model, settings.translationMode, settings.reasoningEffort, policy, strategyVersion(strategy), EXTRACTION_VERSION])
  const replayTraceFile = join(options.outputDir, 'translation-replay.json')
  Object.assign(env, { PAPER_READER_REPLAY_DIR: process.env.PAPER_READER_TRANSLATION_REPLAY === '0' ? '' : join(homeDir, 'translation-il-v1'), PAPER_READER_REPLAY_SCOPE: replayScope, PAPER_READER_REPLAY_TRACE_FILE: replayTraceFile, PAPER_READER_QUALITY_REPORT_FILE: gateway.qualityReportFile ?? '' })
  const lines: string[] = []
  let fatal = ''
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.command.executable, args, { cwd: dirname(options.command.executable), env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const emit = (raw: string) => {
      const line = sanitizeLog(raw, [settings.apiKey, gateway.token]).trim()
      if (!line) return
      lines.push(line); if (lines.length > 100) lines.shift()
      if (/(?:^|\s)ERROR(?:\s+ERROR:|:)|^Traceback\b/.test(line)) fatal = line
      options.onLine?.(line)
    }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8'); let pending = ''
      stream.on('data', chunk => {
        pending += decoder.write(chunk)
        const parts = pending.split(/[\r\n]+/); pending = parts.pop() ?? ''
        for (const part of parts) emit(part)
        if (pending.length > 6000) { emit(pending); pending = '' }
      })
      stream.on('end', () => emit(pending + decoder.end()))
    }
    const abort = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        kill.on('error', () => child.kill())
      } else child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', error => { options.signal?.removeEventListener('abort', abort); reject(new Error(`无法启动翻译引擎：${sanitizeLog(error.message, [settings.apiKey])}`)) })
    child.on('close', code => {
      options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) reject(new Error('翻译已取消。'))
      else if (code !== 0) reject(new Error(readableError(lines.join('\n'))))
      else resolve()
    })
  })
  if (options.signal?.aborted) throw new Error('翻译已取消。')
  const outputs = (await readdir(options.outputDir)).filter(name => /\.mono\.pdf$/i.test(name))
  if (!outputs.length) throw new Error(readableError(fatal || '翻译引擎已退出，但没有生成有效译文。请检查 API 设置与处理记录。'))
  const output = join(options.outputDir, outputs[0])
  try {
    const info = await inspectPdf(output)
    if (!info.pages || !info.hasText) throw new Error('empty')
  } catch { throw new Error('生成的译文 PDF 无法正常读取，请重试。') }
  if (fatal) throw new Error(readableError(lines.join('\n')))
  const outputBytes = await readFile(output)
  const layout = await inspectTranslationLayout(new Uint8Array(outputBytes), sourceIndex.pages.length)
  const thumbnails = await renderLayoutThumbnails(new Uint8Array(outputBytes), layout.issues.flatMap(issue => issue.page === null ? [] : [issue.page]), join(options.outputDir, 'quality-thumbnails'))
  const replay = await readFile(replayTraceFile, 'utf8').then(raw => { const data = JSON.parse(raw); return data?.version === 1 && data.scope === replayScope ? data : null }).catch(() => null)
  await gateway.flushQuality({ layout: { ...layout, thumbnails }, layoutVersion: LAYOUT_VERSION, outputVersion: createHash('sha256').update(outputBytes).digest('hex'), outputFile: output, translationReplay: replay })
  options.onLine?.(`质量报告已保存：${gateway.qualityReportFile}；视觉人工复核仍待进行。`)
  return output
  } finally { await gateway.close() }
}

async function apiError(response: Response, apiKey: string, models = false): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { error?: { message?: string } | string; message?: string }
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message
    if (typeof message === 'string') detail = sanitizeLog(message, [apiKey]).slice(0, 600)
  } catch { /* HTML 或空错误体只显示 HTTP 状态，避免把网页代码放入界面 */ }
  let hint = ''
  if (response.status === 401 || response.status === 403) hint = '请检查 API 密钥及模型访问权限。'
  else if (response.status === 402) hint = '账户余额不足，请检查服务商账户。'
  else if (response.status === 429) hint = '服务商限流或额度不足，请稍后重试。'
  else if (models && [404, 405, 501].includes(response.status)) hint = '此服务未提供模型列表，可手动填写 API 模型 ID。'
  else if ([400, 404, 422].includes(response.status)) hint = '请检查服务地址和 API 模型 ID，可先点击“获取模型”选择。'
  return new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}${hint ? `。${hint}` : ''}`)
}
export async function listModels(input: ProviderSettings): Promise<AvailableModel[]> {
  const settings = validateProvider(input)
  try {
    const response = await fetch(`${settings.baseUrl}/models`, { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.timeout(30000), redirect: 'error' })
    if (!response.ok) throw await apiError(response, settings.apiKey, true)
    const body = await response.json() as { data?: unknown[] }
    if (!Array.isArray(body?.data)) throw new Error('服务商未返回有效的模型列表，请手动填写 API 模型 ID。')
    const models = new Map<string, AvailableModel>()
    for (const item of body.data) {
      const model = item as { id?: unknown; name?: unknown } | null
      if (typeof model?.id !== 'string' || !model.id.trim() || model.id.length > 200 || /[\r\n]/.test(model.id)) continue
      const id = model.id.trim()
      if (!models.has(id)) models.set(id, { id, ...(typeof model.name === 'string' && model.name.trim() ? { name: model.name.trim().slice(0, 200) } : {}) })
    }
    if (!models.size) throw new Error('服务商未返回可用模型，请检查账户权限或手动填写 API 模型 ID。')
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
  } catch (error) {
    const message = sanitizeLog(error instanceof Error ? error.message : String(error), [settings.apiKey])
    throw new Error(message.startsWith('HTTP ') ? message : readableError(message))
  }
}
export async function testConnection(input: ServiceSettings): Promise<string> {
  const settings = validateSettings(input)
  try {
    const body = prepareTranslationRequest({ model: settings.model, messages: [{ role: 'user', content: 'Translate into Simplified Chinese. Output only the translation: Connection successful.' }], stream: false }, settings)
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), redirect: 'error'
    })
    if (!response.ok) throw await apiError(response, settings.apiKey)
    const data = await response.json() as { choices?: { message?: { content?: string } }[] }
    if (typeof data.choices?.[0]?.message?.content !== 'string' || !data.choices[0].message.content.trim()) throw new Error('接口未返回有效的文字回复，请检查地址和模型是否支持 Chat Completions。')
    return '连接成功，模型已返回有效回复。'
  } catch (error) {
    const message = sanitizeLog(error instanceof Error ? error.message : String(error), [settings.apiKey])
    throw new Error(message.startsWith('HTTP ') ? message : readableError(message))
  }
}
