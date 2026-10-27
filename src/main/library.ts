import { ReaderStore, readJson, writeJson } from './store'
import { inspectPdf, runEngine, type RuntimeCommand } from './engine'
import type { DocumentSession, PdfInfo, ServiceSettings, TranslationJob } from '../shared/types'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { parseProgress, sanitizeLog } from '../shared/core'
import { CACHE_VERSIONS, LAYOUT_VERSION, legacyPdfKey, pdfCacheKey, type CacheVersions } from './cache-versions'
import { saveBesideOriginal } from './translation-files'
import type { QuestionDocumentSource } from './document-context'
export const ENGINE_VERSION = LAYOUT_VERSION
interface OpenRecord { session: DocumentSession; source: string }
interface CachedTranslation { path: string; pages: number }
interface PdfSnapshot { id: string; directory: string; source: string; info: PdfInfo }
interface ImportedPair { hash: string; name: string; sourcePath: string; originalPath?: string }
export class LibraryService {
  private records = new Map<string, OpenRecord>()
  private job: TranslationJob | null = null
  private controller?: AbortController
  private running?: Promise<void>
  private starting = false
  constructor(readonly store: ReaderStore, readonly command: RuntimeCommand | null, readonly registerFile: (path: string) => string, readonly onJob: (job: TranslationJob) => void, private versions: CacheVersions = CACHE_VERSIONS, private inspect: typeof inspectPdf = inspectPdf) {}
  getJob() { return this.job ? structuredClone(this.job) : null }
  async saveSettings(settings: ServiceSettings): Promise<void> {
    if (this.starting || this.job?.status === 'running') throw new Error('翻译任务进行中，请完成或取消后再修改设置。')
    await this.store.saveSettings(settings)
  }
  getSession(id: string) {
    const record = this.records.get(id)
    if (!record) throw new Error('请先打开论文。')
    return record.session
  }
  async questionSource(id: string, sourceVersion: string): Promise<QuestionDocumentSource> {
    const session = this.getSession(id)
    if (sourceVersion !== 'original' && (!session.translationKey || sourceVersion !== `translated:${session.translationKey}`)) throw new Error('提问所选版本已变化，请重新选择文字。')
    const path = sourceVersion === 'original' ? this.records.get(id)!.source : await this.translatedFile(id)
    return { documentId: id, documentHash: createHash('sha256').update(await readFile(path)).digest('hex'), sourceVersion, path, pages: sourceVersion === 'original' ? session.pages : session.translatedPages! }
  }
  private key(id: string, settings: ServiceSettings) { return pdfCacheKey(id, settings, this.versions) }
  private async cachedFor(id: string, settings: ServiceSettings) {
    const key = this.key(id, settings)
    const current = await this.cached(key)
    if (current) return { ...current, key }
    if (settings.translationMode === 'economy') {
      const standard = { ...settings, translationMode: 'manual' as const, reasoningEffort: 'high' as const }
      const standardKey = this.key(id, standard)
      const compatible = await this.cached(standardKey)
      if (compatible) return { ...compatible, key: standardKey }
      const oldStandardKey = legacyPdfKey(id, standard, this.versions)
      const oldStandard = oldStandardKey ? await this.cached(oldStandardKey) : null
      if (oldStandard) return { ...oldStandard, key: oldStandardKey! }
    }
    const legacyKey = legacyPdfKey(id, settings, this.versions)
    const legacy = legacyKey ? await this.cached(legacyKey) : null
    return legacy ? { ...legacy, key: legacyKey! } : null
  }
  private async cached(key: string): Promise<CachedTranslation | null> {
    const entry = await readJson<CachedTranslation | null>(join(this.store.directory, 'translations', key, 'completed.json'), null)
    if (!entry) return null
    try { const info = await this.inspect(entry.path); return { path: entry.path, pages: info.pages } } catch { return null }
  }
  private async snapshot(path: string): Promise<PdfSnapshot> {
    if (typeof path !== 'string' || extname(path).toLowerCase() !== '.pdf') throw new Error('请选择 PDF 文件。')
    const bytes = await readFile(path).catch(() => { throw new Error('无法读取此文件，请检查文件是否存在及访问权限。') })
    const id = createHash('sha256').update(bytes).digest('hex')
    const directory = join(this.store.directory, 'documents', id)
    const source = join(directory, 'original.pdf')
    await mkdir(directory, { recursive: true })
    const existingHash = await readFile(source).then(data => createHash('sha256').update(data).digest('hex'), () => '')
    if (existingHash !== id) {
      const temporary = join(directory, `original-${randomUUID()}.tmp`)
      await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, source)
    }
    const info = await this.inspect(source)
    await writeJson(join(directory, 'source.json'), { path }).catch(() => {})
    return { id, directory, source, info }
  }
  async openFile(path: string): Promise<DocumentSession> {
    return this.openSnapshot(path, await this.snapshot(path))
  }
  private async openSnapshot(path: string, snapshot: PdfSnapshot, imported?: ImportedPair): Promise<DocumentSession> {
    const { id, directory, source, info } = snapshot
    const session: DocumentSession = { id, name: basename(path), path, pages: info.pages, hasText: info.hasText, language: info.language, originalUrl: this.registerFile(source), reading: await this.store.reading(id) }
    const pair = imported ?? await readJson<ImportedPair | null>(join(directory, 'pair.json'), null)
    if (pair) {
      if (!/^[a-f0-9]{64}$/.test(pair.hash) || typeof pair.name !== 'string' || typeof pair.sourcePath !== 'string') throw new Error('本地对照记录无效，请重新导入中英 PDF。')
      const translated = join(this.store.directory, 'documents', pair.hash, 'original.pdf')
      const translatedInfo = await this.inspect(translated).catch(() => { throw new Error('已导入的中文副本无法读取，请重新导入中英 PDF。') })
      session.translatedUrl = this.registerFile(translated); session.translatedPages = translatedInfo.pages
      session.translationKey = pair.hash; session.translationSource = 'imported'; session.translatedName = pair.name; session.translatedPath = pair.sourcePath
    } else {
      const settings = await this.store.settings().catch(() => null)
      if (settings?.model) {
        const cached = await this.cachedFor(id, settings)
        if (cached) {
          session.translatedUrl = this.registerFile(cached.path); session.translatedPages = cached.pages; session.translationKey = cached.key; session.translationSource = 'generated'
          Object.assign(session, await this.saveGeneratedCopy(cached.path, session.path))
        }
      }
    }
    // Complete all validation and fallible reads before replacing an existing pairing.
    if (imported) await writeJson(join(directory, 'pair.json'), imported)
    this.records.set(id, { session, source })
    return structuredClone(session)
  }
  async importPair(originalPath: string, translatedPath: string): Promise<DocumentSession> {
    const original = await this.snapshot(originalPath)
    const translated = await this.snapshot(translatedPath)
    return this.pairSnapshots(originalPath, original, translated, translatedPath)
  }
  private async pairSnapshots(originalPath: string, original: PdfSnapshot, translated: PdfSnapshot, translatedPath: string, translatedName = basename(translatedPath)): Promise<DocumentSession> {
    if (original.id === translated.id) throw new Error('两侧是相同内容的 PDF，请选择两份不同的论文。')
    if (this.starting || (this.job?.status === 'running' && this.job.documentId === original.id)) throw new Error('这篇论文正在翻译，请完成或取消后再导入中文版本。')
    return this.openSnapshot(originalPath, original, { hash: translated.id, name: translatedName, sourcePath: translatedPath, originalPath })
  }
  private openedSnapshot(id: string): PdfSnapshot {
    const session = this.getSession(id)
    return { id, directory: join(this.store.directory, 'documents', id), source: this.records.get(id)!.source, info: { pages: session.pages, hasText: session.hasText, language: session.language } }
  }
  async importSide(id: string, side: 'left' | 'right', source: string | { documentId: string }): Promise<DocumentSession> {
    if (side !== 'left' && side !== 'right') throw new Error('请选择左侧或右侧阅读栏。')
    const session = this.getSession(id)
    if (typeof source !== 'string' && (!source || typeof source.documentId !== 'string')) throw new Error('拖入的论文无效。')
    const path = typeof source === 'string' ? source : this.getSession(source.documentId).path
    const incoming = typeof source === 'string' ? await this.snapshot(source) : this.openedSnapshot(source.documentId)
    if (side === 'right') {
      return this.pairSnapshots(session.path, this.openedSnapshot(id), incoming, path)
    }
    if (!session.translatedUrl) return this.openSnapshot(path, incoming)
    const translated = await this.snapshot(await this.translatedFile(id))
    return this.pairSnapshots(path, incoming, translated, session.translatedPath ?? translated.source, session.translatedName ?? '右侧论文.pdf')
  }
  async translate(id: string): Promise<TranslationJob> {
    if (!this.command) throw new Error('自动翻译已移除，请导入已有的中文 PDF。')
    if (this.starting || this.job?.status === 'running') throw new Error('已有翻译任务正在运行，请等待完成或先取消。')
    this.starting = true
    try {
      const record = this.records.get(id)
      if (!record) throw new Error('请先打开论文。')
      if (!record.session.hasText) throw new Error('未检测到可选中的正文，此 PDF 可能是扫描件。请先完成 OCR 文字识别。')
      if (record.session.language === 'zh') throw new Error('这篇论文已是中文，可以直接阅读和批注。')
      const settings = await this.store.settings()
      if (!settings.apiKey || !settings.model) throw new Error('请先在API 设置中填写服务地址、模型和 API 密钥。')
      const cached = await this.cachedFor(id, settings)
      const key = cached?.key ?? this.key(id, settings)
      this.job = { id: randomUUID(), documentId: id, status: 'running', stage: '正在启动翻译引擎', percent: null, startedAt: Date.now(), logs: [] }
      this.controller = new AbortController()
      if (cached) {
        const saved = await this.saveGeneratedCopy(cached.path, record.session.path)
        const current = this.records.get(id) ?? record
        current.session.translatedUrl = this.registerFile(cached.path); current.session.translatedPages = cached.pages; current.session.translationKey = key
        current.session.translationSource = 'generated'; delete current.session.translatedName; delete current.session.translatedPath
        Object.assign(current.session, saved)
        this.job.status = 'completed'; this.job.stage = '已载入本地译文'; this.job.percent = 100; this.job.finishedAt = Date.now(); this.job.result = structuredClone(current.session)
        this.publish()
      } else {
        this.publish()
        this.running = this.execute(record, settings, key, this.job, this.controller.signal, this.command)
      }
      return structuredClone(this.job)
    } finally { this.starting = false }
  }
  private publish() { if (this.job) this.onJob(structuredClone(this.job)) }
  private async saveGeneratedCopy(output: string, originalPath: string): Promise<Pick<DocumentSession, 'savedTranslationPath' | 'saveWarning'>> {
    try { return { savedTranslationPath: await saveBesideOriginal(output, originalPath), saveWarning: undefined } }
    catch { return { savedTranslationPath: undefined, saveWarning: '中文译文已生成，但无法自动写入原文目录。已保留本地译文，请点击“另存译文”选择可保存的位置。' } }
  }
  private async execute(record: OpenRecord, settings: ServiceSettings, key: string, job: TranslationJob, signal: AbortSignal, command: RuntimeCommand): Promise<void> {
    const directory = join(this.store.directory, 'translations', key)
    try {
      let lastPublish = 0
      const output = await runEngine({ command, input: record.source, outputDir: join(directory, job.id), homeDir: join(this.store.directory, 'engine-home'), taskId: job.id, translationPolicyVersion: this.versions.translation, strategy: this.versions.strategy, settings, signal, onUsage: usage => { job.usage = usage; this.publish() }, onLine: line => {
        const progress = parseProgress(line)
        if (progress.stage !== '正在处理论文' || job.stage === '正在启动翻译引擎') { job.stage = progress.stage; job.percent = progress.percent }
        job.logs.push(line); if (job.logs.length > 100) job.logs.shift()
        if (Date.now() - lastPublish > 150) { lastPublish = Date.now(); this.publish() }
      } })
      if (signal.aborted) throw new Error('翻译已取消。')
      const info = await this.inspect(output)
      if (signal.aborted) throw new Error('翻译已取消。')
      await writeJson(join(directory, 'completed.json'), { path: output, pages: info.pages })
      const saved = await this.saveGeneratedCopy(output, record.session.path)
      const current = this.records.get(job.documentId) ?? record
      current.session.translatedUrl = this.registerFile(output); current.session.translatedPages = info.pages; current.session.translationKey = key
      current.session.translationSource = 'generated'; delete current.session.translatedName; delete current.session.translatedPath
      Object.assign(current.session, saved)
      job.status = 'completed'; job.percent = 100; job.stage = '全文翻译完成'; job.result = structuredClone(current.session)
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : 'failed'
      job.error = sanitizeLog(error instanceof Error ? error.message : String(error), [settings.apiKey])
      job.stage = signal.aborted ? '翻译已取消' : '翻译未完成'
      job.percent = null
    } finally { job.finishedAt = Date.now(); this.publish() }
  }
  async cancel(id: string): Promise<void> {
    if (this.job?.id !== id || this.job.status !== 'running') return
    this.controller?.abort()
    await this.running
  }
  async shutdown(): Promise<void> { if (this.job?.status === 'running') await this.cancel(this.job.id) }
  async translatedFile(id: string): Promise<string> {
    const session = this.getSession(id)
    if (session.translationSource === 'imported' && session.translationKey && /^[a-f0-9]{64}$/.test(session.translationKey)) {
      const path = join(this.store.directory, 'documents', session.translationKey, 'original.pdf')
      await this.inspect(path)
      return path
    }
    const key = session.translationKey ?? this.key(id, await this.store.settings())
    const entry = await this.cached(key)
    if (!entry) throw new Error('尚无可阅读的中文版本，请先导入中英对照。')
    return entry.path
  }
  async saveTranslation(id: string, destination: string): Promise<void> {
    const session = this.getSession(id)
    const source = await this.translatedFile(id)
    const pair = await readJson<ImportedPair | null>(join(this.store.directory, 'documents', id, 'pair.json'), null)
    const protectedPaths = [session.path, source, pair?.originalPath, pair?.sourcePath]
    if (protectedPaths.some(path => path && resolve(path).toLowerCase() === resolve(destination).toLowerCase())) throw new Error('请使用新文件名保存，以保留导入的原始 PDF。')
    await copyFile(source, destination)
  }
}
