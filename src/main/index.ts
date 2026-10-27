import { app, BrowserWindow, ipcMain, protocol, net, safeStorage, dialog, shell, Menu, utilityProcess, clipboard } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve, dirname, isAbsolute, extname, basename, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ReaderStore } from './store'
import { LibraryService } from './library'
import { listModels, testConnection } from './engine'
import type { ProviderSettings, PublicSettings, Result, ServiceSettings } from '../shared/types'
import { sanitizeLog } from '../shared/core'
import { mkdirSync } from 'node:fs'
import { AnnotationStore } from './annotations'
import { DocumentContext } from './document-context'
import { QuestionService } from './question-service'
import { PdfRasterService } from './pdf-raster-service'
import { PdfInspectionService } from './pdf-inspection-service'

protocol.registerSchemesAsPrivileged([
  { scheme: 'paper-pdf', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'paper-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
const here = dirname(fileURLToPath(import.meta.url))
let window: BrowserWindow | null = null
let library: LibraryService
let quitting = false
const pdfFiles = new Map<string, string>()
const pdfUrls = new Map<string, string>()
function registerPdf(path: string): string {
  if (pdfUrls.has(path)) return pdfUrls.get(path)!
  const token = randomUUID(); const url = `paper-pdf://${token}/document.pdf`
  pdfFiles.set(token, path); pdfUrls.set(path, url)
  return url
}
const redact = (settings: ServiceSettings): PublicSettings => ({ baseUrl: settings.baseUrl, model: settings.model, qps: settings.qps, reasoningEffort: settings.reasoningEffort ?? 'high', translationMode: settings.translationMode ?? 'manual', hasApiKey: Boolean(settings.apiKey) })

async function start() {
const customData = app.commandLine.getSwitchValue('data-dir')
if (customData) {
  if (!isAbsolute(customData)) throw new Error('--data-dir 必须为绝对路径')
  mkdirSync(customData, { recursive: true })
  app.setPath('userData', customData)
}
await app.whenReady()
await mkdir(app.getPath('userData'), { recursive: true })
const store = new ReaderStore(app.getPath('userData'), {
  encrypt(value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，无法保存 API 密钥。')
    return safeStorage.encryptString(value)
  },
  decrypt(value) { return safeStorage.decryptString(value) }
})
const inspector = new PdfInspectionService(new URL('./pdf-inspection-worker.js', import.meta.url))
library = new LibraryService(store, null, registerPdf, () => {}, undefined, path => inspector.inspect(path))
const annotations = new AnnotationStore(store.directory)
// Resolve the worker beside this entry, since DocumentContext is shared with
// the worker and Rollup may place that module in a chunks/ directory.
const questions = new QuestionService({ directory: store.directory, context: new DocumentContext(store.directory, { workerUrl: new URL('./document-context-worker.js', import.meta.url) }), resolveSource: (id, version) => library.questionSource(id, version), settings: () => store.settings(), onEvent: event => { if (window && !window.isDestroyed()) window.webContents.send('reader:question', event) } })
const prepareQuestions = (id: string, translated = false) => { void questions.prepare(id, translated ? `translated:${library.getSession(id).translationKey}` : 'original').catch(() => {}) }

protocol.handle('paper-pdf', async request => {
  const url = new URL(request.url)
  const path = pdfFiles.get(url.hostname)
  if (!path || url.pathname !== '/document.pdf' || request.method !== 'GET') return new Response('Not found', { status: 404 })
  return net.fetch(pathToFileURL(path).href, { headers: request.headers })
})
const rendererRoot = resolve(here, '../renderer')
const raster = new PdfRasterService({ assets: join(rendererRoot, 'pdf-assets'), spawn(path, assets) {
  // A process per PDF also isolates Skia's process-global font registry. Closing
  // a translation must never unregister a font still used by the original.
  const child = utilityProcess.fork(join(here, 'pdf-raster-process.js'), [`--raster-init=${JSON.stringify({ path, assets })}`], { serviceName: 'PDF raster', stdio: 'ignore' })
  const events = child as NodeJS.EventEmitter
  return { postMessage: message => child.postMessage(message), on: (event, listener) => events.on(event, listener), once: (event, listener) => events.once(event, listener), terminate: () => child.kill() }
}, resolvePdf(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'paper-pdf:' && parsed.pathname === '/document.pdf' ? pdfFiles.get(parsed.hostname) : undefined } catch { return undefined }
} })
protocol.handle('paper-app', request => {
  const url = new URL(request.url)
  if (url.hostname !== 'ui') return new Response('Not found', { status: 404 })
  const path = resolve(rendererRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`)
  const rel = relative(rendererRoot, path)
  if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Not found', { status: 404 })
  return net.fetch(pathToFileURL(path).href)
})
const handle = <T>(name: string, action: (...args: any[]) => Promise<T> | T) => {
  ipcMain.handle(`reader:${name}`, async (event, ...args): Promise<Result<T>> => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '不允许的调用来源。' }
    try { return { ok: true, value: await action(...args) } }
    catch (error) {
      let secrets: string[] = []
      try { secrets = [(await store.settings()).apiKey] } catch { /* 配置损坏时仍显示原始错误 */ }
      return { ok: false, error: sanitizeLog(error instanceof Error ? error.message : String(error), secrets) }
    }
  })
}
const withKey = async <T extends ProviderSettings>(settings: T) => ({ ...settings, ...await store.credentials(settings) })
handle('info', async () => ({ version: app.getVersion(), dataPath: store.directory, initialPath: process.argv.find(arg => !arg.startsWith('-') && extname(arg).toLowerCase() === '.pdf') ?? await store.lastDocument() ?? undefined }))
handle('save-last-document', (path: string | null) => {
  if (path !== null && (typeof path !== 'string' || !isAbsolute(path) || extname(path).toLowerCase() !== '.pdf')) throw new Error('论文路径无效。')
  return store.saveLastDocument(path)
})
handle('open-pdf-raster', (owner: string, url: string) => raster.open(owner, url))
handle('render-pdf-raster', (owner: string, request: import('../shared/pdf-raster').PdfRasterRequest) => raster.render(owner, request))
handle('prioritize-pdf-raster', (owner: string, id: string, priority: number) => raster.prioritize(owner, id, priority))
handle('cancel-pdf-raster', (owner: string, id: string) => raster.cancel(owner, id))
handle('close-pdf-raster', (owner: string) => raster.close(owner))
handle('settings', async () => redact(await store.settings()))
handle('save-settings', async (settings: ServiceSettings) => { await store.saveSettings(settings); return redact(await store.settings()) })
handle('test-connection', async (settings: ServiceSettings) => testConnection(await withKey(settings)))
handle('list-models', async (settings: ProviderSettings) => listModels(await withKey(settings)))
handle('open-pdf', async (path?: string) => {
  if (!path) {
    const selected = await dialog.showOpenDialog(window!, { title: '打开论文', properties: ['openFile'], filters: [{ name: 'PDF 论文', extensions: ['pdf'] }] })
    if (selected.canceled) return null
    path = selected.filePaths[0]
  }
  const session = await library.openFile(path)
  prepareQuestions(session.id)
  if (session.translatedUrl) prepareQuestions(session.id, true)
  return session
})
handle('select-pdf', async (path?: string) => {
  if (!path) {
    const selected = await dialog.showOpenDialog(window!, { title: '选择 PDF', properties: ['openFile'], filters: [{ name: 'PDF 文件', extensions: ['pdf'] }] })
    if (selected.canceled) return null
    path = selected.filePaths[0]
  }
  if (typeof path !== 'string' || extname(path).toLowerCase() !== '.pdf') throw new Error('请选择 PDF 文件。')
  return { path, name: basename(path), ...await inspector.inspect(path) }
})
handle('import-pair', async (originalPath: string, translatedPath: string) => { const session = await library.importPair(originalPath, translatedPath); prepareQuestions(session.id); prepareQuestions(session.id, true); return session })
handle('import-side', async (id: string, side: 'left' | 'right', source: string | { documentId: string }) => { const session = await library.importSide(id, side, source); prepareQuestions(session.id); if (session.translatedUrl) prepareQuestions(session.id, true); return session })
handle('save-reading', (id, state) => { library.getSession(id); return store.saveReading(id, state) })
handle('export', async (id: string) => {
  const session = library.getSession(id)
  await library.translatedFile(id)
  const selected = await dialog.showSaveDialog(window!, { title: '另存右侧 PDF', defaultPath: join(dirname(session.path), session.translatedName ?? `${basename(session.name, extname(session.name))}.右侧.pdf`), filters: [{ name: 'PDF 文件', extensions: ['pdf'] }] })
  if (selected.canceled || !selected.filePath) return null
  await library.saveTranslation(id, selected.filePath)
  return selected.filePath
})
handle('show-data', async () => { const error = await shell.openPath(store.directory); if (error) throw new Error(error) })
handle('annotations', (id: string) => { library.getSession(id); return annotations.list(id) })
handle('add-annotation', (id, draft) => {
  const session = library.getSession(id)
  const pageCount = draft?.sourceKey === 'original' ? session.pages : draft?.sourceKey === `translated:${session.translationKey}` ? session.translatedPages : undefined
  if (!pageCount || !Array.isArray(draft?.anchors) || draft.anchors.some((anchor: { page: number }) => anchor.page > pageCount)) throw new Error('批注对应的文档或页码无效。')
  return annotations.add(id, draft)
})
handle('edit-annotation', (id, annotationId, changes) => { library.getSession(id); return annotations.edit(id, annotationId, changes) })
handle('delete-annotation', (id, annotationId) => { library.getSession(id); return annotations.remove(id, annotationId) })
handle('start-question', request => questions.start(request))
handle('cancel-question', (id, requestId) => { library.getSession(id); return questions.cancel(id, requestId) })
handle('question-history', id => { library.getSession(id); return questions.history(id) })
handle('delete-question-history', (id, conversationId) => { library.getSession(id); return questions.removeHistory(id, conversationId) })
handle('question-usage', () => questions.usage())
handle('copy-text', text => {
  if (typeof text !== 'string' || text.length > 100000) throw new Error('要复制的回答内容无效。')
  clipboard.writeText(text)
})

window = new BrowserWindow({
  width: 1440, height: 960, minWidth: 1000, minHeight: 680, title: '论文对照阅读器', backgroundColor: '#f5f5f2',
  icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(here, '../../resources/icon.png'),
  webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
})
Menu.setApplicationMenu(null)
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
window.webContents.on('will-navigate', event => event.preventDefault())
window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) void raster.shutdown() })
window.webContents.on('render-process-gone', () => { void raster.shutdown() })
window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
let closeAllowed = false; let closeTimer: ReturnType<typeof setTimeout> | undefined
const finishClose = () => { clearTimeout(closeTimer); closeAllowed = true; if (window && !window.isDestroyed()) window.close() }
window.on('close', event => {
  if (closeAllowed) return
  event.preventDefault()
  if (!closeTimer) { window!.webContents.send('reader:prepare-close'); closeTimer = setTimeout(finishClose, 1500) }
})
ipcMain.on('reader:ready-to-close', event => { if (window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) finishClose() })
if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
else await window.loadURL('paper-app://ui/index.html')
window.on('closed', () => { clearTimeout(closeTimer); window = null })
app.on('window-all-closed', () => app.quit())
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault(); quitting = true
  Promise.allSettled([library.shutdown(), inspector.shutdown(), questions.shutdown(), raster.shutdown(), annotations.flush(), store.flush()]).finally(() => app.quit())
})
}
void start().catch(error => { console.error(error); dialog.showErrorBox('论文阅读器启动失败', String(error)); app.exit(1) })
