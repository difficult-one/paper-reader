import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, rename, mkdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { ReaderStore } from '../src/main/store'
import { LibraryService } from '../src/main/library'
import { AnnotationStore } from '../src/main/annotations'
import * as translationFiles from '../src/main/translation-files'
import type { TranslationJob } from '../src/shared/types'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { cacheKey } from '../src/shared/core'
const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function setup(mode = 'success') {
  const dir = await mkdtemp(join(tmpdir(), 'reader-library-')); dirs.push(dir)
  const store = new ReaderStore(dir, { encrypt: s => Buffer.from(s.split('').reverse().join('')), decrypt: b => b.toString().split('').reverse().join('') })
  await store.saveSettings({ baseUrl: 'https://example.com/v1', model: 'a', apiKey: 'secret-key', qps: 1 })
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage().drawText('A research paper with readable English text.', { font })
  const path = join(dir, 'original paper.pdf'); await writeFile(path, await pdf.save())
  let finished!: (job: TranslationJob) => void
  const completion = new Promise<TranslationJob>(resolve => { finished = resolve })
  const library = new LibraryService(store, { executable: process.execPath, prefixArgs: [resolve('tests/fixtures/engine.cjs'), mode] }, p => `test:${p}`, job => { if (job.status !== 'running') finished(job) })
  return { dir, path, library, store, completion }
}
it('未配置翻译引擎时保留 PDF 阅读并拒绝启动自动翻译', async () => {
  const { path, store } = await setup()
  const library = new LibraryService(store, null, p => `test:${p}`, () => {})
  const doc = await library.openFile(path)
  expect(doc.pages).toBe(1)
  await expect(library.translate(doc.id)).rejects.toThrow('自动翻译已移除')
  expect(library.getJob()).toBeNull()
})
it('完成后再次打开复用译文，更换模型不会误用旧缓存', async () => {
  const { path, library, completion, store } = await setup()
  const doc = await library.openFile(path)
  const source = await readFile(path)
  expect(doc.translatedUrl).toBeUndefined()
  await library.translate(doc.id)
  expect((await completion).status).toBe('completed')
  expect((await library.openFile(path)).translatedUrl).toBeDefined()
  await store.saveSettings({ baseUrl: 'https://example.com/v1', model: 'b', apiKey: '', qps: 1 })
  expect((await library.openFile(path)).translatedUrl).toBeUndefined()
  expect(await readFile(path)).toEqual(source)
})

it('切换保真省钱时优先复用兼容的完整标准思考译文及其批注版本', async () => {
  const { path, library, completion, store } = await setup()
  const doc = await library.openFile(path); await library.translate(doc.id); await completion
  const old = await library.openFile(path)
  await store.saveSettings({ ...await store.settings(), translationMode: 'economy' })
  const next = await library.openFile(path)
  expect(next.translatedUrl).toBe(old.translatedUrl)
  expect(next.translationKey).toBe(old.translationKey)
})
it('阻止并行重复启动，取消后释放任务锁', async () => {
  const { path, library, completion } = await setup('slow')
  const doc = await library.openFile(path)
  const job = await library.translate(doc.id)
  await expect(library.translate(doc.id)).rejects.toThrow(/任务/)
  await library.cancel(job.id)
  expect((await completion).status).toBe('cancelled')
})
it('无输出时产生失败状态而非完成，不写入完成缓存', async () => {
  const { path, library, completion } = await setup('empty')
  const doc = await library.openFile(path)
  await library.translate(doc.id)
  const failed = await completion
  expect(failed.status).toBe('failed')
  expect(failed.error).toContain('译文')
  expect((await library.openFile(path)).translatedUrl).toBeUndefined()
})
it('运行任务期间拒绝修改翻译配置，完成或取消后可修改', async () => {
  const { path, library, store } = await setup('slow')
  const doc = await library.openFile(path); const job = await library.translate(doc.id)
  try {
    await expect(library.saveSettings({ baseUrl: 'https://example.com/v1', model: 'b', apiKey: '', qps: 1 })).rejects.toThrow(/任务/)
    expect((await store.settings()).model).toBe('a')
  } finally { await library.cancel(job.id) }
  await library.saveSettings({ baseUrl: 'https://example.com/v1', model: 'b', apiKey: '', qps: 1 })
  expect((await store.settings()).model).toBe('b')
})
it('缓存原文快照损坏后，重新导入有效原文可以恢复', async () => {
  const { dir, path, library } = await setup()
  const doc = await library.openFile(path)
  await writeFile(join(dir, 'documents', doc.id, 'original.pdf'), 'truncated')
  expect((await library.openFile(path)).pages).toBe(1)
})
it('翻译期间重开同一论文，完成后当前会话也获得译文与批注版本标识', async () => {
  const { dir, path, library, completion } = await setup('delayed')
  const doc = await library.openFile(path)
  await library.translate(doc.id)
  const alias = join(dir, 'renamed paper.pdf'); await writeFile(alias, await readFile(path))
  await library.openFile(alias)
  const finished = await completion
  expect(library.getSession(doc.id).translationKey).toBeTruthy()
  expect(library.getSession(doc.id).translationKey).toBe(finished.result?.translationKey)
  expect(finished.result?.name).toBe('renamed paper.pdf')
})

async function secondPdf(dir: string, name = '中文 version.pdf', pages = 1) {
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.setTitle(name)
  for (let index = 0; index < pages; index++) pdf.addPage().drawText(`An imported version page ${index + 1}`, { font })
  const path = join(dir, name); await writeFile(path, await pdf.save()); return path
}
it('右侧直接导入使用已打开论文的快照，原文件移动后仍保留标识及文件名', async () => {
  const { dir, path, library } = await setup()
  const original = await library.openFile(path)
  const other = await secondPdf(dir, 'another English paper.pdf')
  await rename(path, join(dir, 'moved-original.pdf'))
  const paired = await library.importSide(original.id, 'right', other)
  expect(paired.id).toBe(original.id)
  expect(paired.path).toBe(path)
  expect(paired.name).toBe('original paper.pdf')
  expect(paired.translatedName).toBe('another English paper.pdf')
  expect(paired.translatedPages).toBe(1)
})
it('左侧直接更换保留右侧快照，原有论文会话和对照仍可读取', async () => {
  const { dir, path, library } = await setup()
  const other = await secondPdf(dir, 'right paper.pdf')
  const paired = await library.importPair(path, other)
  const nextLeft = await secondPdf(dir, 'new-left.pdf', 2)
  await rename(path, join(dir, 'moved-left.pdf')); await rename(other, join(dir, 'moved-right.pdf'))
  const next = await library.importSide(paired.id, 'left', nextLeft)
  expect(next.id).not.toBe(paired.id)
  expect(next.name).toBe('new-left.pdf')
  expect(next.translationKey).toBe(paired.translationKey)
  expect(next.translatedName).toBe('right paper.pdf')
  expect(library.getSession(paired.id).translationKey).toBe(paired.translationKey)
  expect(await readFile(await library.translatedFile(next.id))).toEqual(await readFile(join(dir, 'moved-right.pdf')))
})
it('直接拖入相同文件、损坏文件或无效侧别不会替换已有配对', async () => {
  const { dir, path, library } = await setup()
  const other = await secondPdf(dir)
  const paired = await library.importPair(path, other)
  const invalid = join(dir, 'broken.pdf'); await writeFile(invalid, '%PDF-invalid')
  await expect(library.importSide(paired.id, 'right', path)).rejects.toThrow(/相同/)
  await expect(library.importSide(paired.id, 'left', other)).rejects.toThrow(/相同/)
  await expect(library.importSide(paired.id, 'right', invalid)).rejects.toThrow(/损坏|解析/)
  await expect(library.importSide(paired.id, 'invalid' as 'left', other)).rejects.toThrow(/侧/)
  expect(library.getSession(paired.id).translationKey).toBe(paired.translationKey)
})
it('从论文列表拖入使用已打开快照，不依赖外部源文件仍在原位置', async () => {
  const { dir, path, library } = await setup()
  const left = await library.openFile(path)
  const rightPath = await secondPdf(dir, 'other-English.pdf')
  const right = await library.openFile(rightPath)
  await rename(rightPath, join(dir, 'moved-other.pdf'))
  const paired = await library.importSide(left.id, 'right', { documentId: right.id })
  expect(paired.translationKey).toBe(right.id)
  expect(paired.translatedName).toBe('other-English.pdf')
  expect(paired.translatedPath).toBe(rightPath)
})
it('无 API 配置即可导入两份 PDF，导出使用当前显示的导入文件', async () => {
  const { dir, path } = await setup()
  const store = new ReaderStore(join(dir, 'unconfigured'), { encrypt: s => Buffer.from(s), decrypt: b => b.toString() })
  const library = new LibraryService(store, { executable: 'unavailable' }, p => `test:${p}`, () => { throw new Error('不应启动翻译') })
  const translated = await secondPdf(dir)
  const session = await library.importPair(path, translated)
  expect(session.translationSource).toBe('imported')
  expect(session.translatedName).toBe('中文 version.pdf')
  expect(session.translatedPages).toBe(1)
  expect((await store.settings()).apiKey).toBe('')
  expect(await readFile(await library.translatedFile(session.id))).toEqual(await readFile(translated))
  expect(library.getJob()).toBeNull()
  const annotations = new AnnotationStore(store.directory)
  const note = await annotations.add(session.id, { sourceKey: `translated:${session.translationKey}`, quote: 'Imported text', note: '可在导入版本批注', color: 'yellow', anchors: [{ page: 1, rects: [{ x: .1, y: .1, width: .2, height: .03 }] }] })
  expect((await annotations.list(session.id))[0].id).toBe(note.id)
})
it('重启及服务设置更换后恢复已导入配对，不依赖中文源文件位置', async () => {
  const { dir, path, library, store } = await setup()
  const translated = await secondPdf(dir, '中文.pdf', 2)
  const session = await library.importPair(path, translated)
  await rename(translated, join(dir, 'moved.pdf'))
  await store.saveSettings({ baseUrl: 'https://different.example/v1', model: 'new', apiKey: 'new-key', qps: 2 })
  const restarted = new LibraryService(store, { executable: 'unavailable' }, p => `restored:${p}`, () => {})
  const restored = await restarted.openFile(path)
  expect(restored.translationKey).toBe(session.translationKey)
  expect(restored.translationSource).toBe('imported')
  expect(restored.translatedPages).toBe(2)
  expect(restored.translatedUrl).toContain('restored:')
  expect((await readFile(await restarted.translatedFile(restored.id))).subarray(0, 5).toString()).toBe('%PDF-')
})
it('更换中文版本保留论文标识，但使用独立批注版本；再次导入相同内容保持版本标识', async () => {
  const { dir, path, library } = await setup()
  const one = await secondPdf(dir, 'first.pdf')
  const two = await secondPdf(dir, 'second.pdf')
  const a = await library.importPair(path, one)
  const b = await library.importPair(path, two)
  expect(b.id).toBe(a.id)
  expect(b.translationKey).not.toBe(a.translationKey)
  expect((await library.importPair(path, two)).translationKey).toBe(b.translationKey)
})
it('损坏或相同内容的配对不会替换已有有效配对', async () => {
  const { dir, path, library } = await setup()
  const valid = await library.importPair(path, await secondPdf(dir))
  const invalid = join(dir, 'broken.pdf'); await writeFile(invalid, '%PDF-invalid')
  await expect(library.importPair(path, invalid)).rejects.toThrow(/损坏|解析/)
  const alias = join(dir, 'same-content.pdf'); await writeFile(alias, await readFile(path))
  await expect(library.importPair(path, alias)).rejects.toThrow(/同一|相同/)
  expect((await library.openFile(path)).translationKey).toBe(valid.translationKey)
})
it('手动翻译后导出当前生成版本，而非此前导入版本', async () => {
  const { dir, path, library, completion } = await setup()
  const session = await library.importPair(path, await secondPdf(dir))
  const imported = await library.translatedFile(session.id)
  await library.translate(session.id); await completion
  expect(library.getSession(session.id).translationSource).toBe('generated')
  expect(await library.translatedFile(session.id)).not.toBe(imported)
})
it('切换生成译文和重命名原文后，导出仍保护两个导入源文件', async () => {
  const { dir, path, library, completion } = await setup()
  const translated = await secondPdf(dir)
  const before = await readFile(translated)
  const session = await library.importPair(path, translated)
  await library.translate(session.id); await completion
  await expect(library.saveTranslation(session.id, translated)).rejects.toThrow(/新文件名|原始/)
  expect(await readFile(translated)).toEqual(before)
  const alias = join(dir, 'renamed-original.pdf'); await writeFile(alias, await readFile(path))
  await library.openFile(alias)
  await expect(library.saveTranslation(session.id, path)).rejects.toThrow(/新文件名|原始/)
  const destination = join(dir, 'export.pdf')
  await library.saveTranslation(session.id, destination)
  expect(await readFile(destination)).toEqual(before)
})
it('阅读记录损坏导致导入失败时，保留此前配对与当前会话', async () => {
  const { dir, path, library, store } = await setup()
  const session = await library.importPair(path, await secondPdf(dir, 'old.pdf'))
  const pairPath = join(dir, 'documents', session.id, 'pair.json')
  const before = await readFile(pairPath)
  await store.saveReading(session.id, { left: { page: 1, fraction: 0 }, right: { page: 1, fraction: 0 }, linked: true, zoom: 1, split: 50 })
  await writeFile(join(dir, 'reading', `${session.id}.json`), '{truncated')
  await expect(library.importPair(path, await secondPdf(dir, 'new.pdf'))).rejects.toThrow(/记录无法读取/)
  expect(await readFile(pairPath)).toEqual(before)
  expect(library.getSession(session.id).translationKey).toBe(session.translationKey)
})
it('新翻译自动保存到原文目录，并记录源路径和实际输出路径', async () => {
  const { dir, path, library, completion } = await setup()
  const session = await library.openFile(path)
  await library.translate(session.id)
  const job = await completion
  expect(job.status).toBe('completed')
  expect(job.result?.savedTranslationPath).toBe(join(dir, 'original paper.中文译文.pdf'))
  expect(await readFile(job.result!.savedTranslationPath!)).toEqual(await readFile(await library.translatedFile(session.id)))
  expect(JSON.parse(await readFile(join(dir, 'documents', session.id, 'source.json'), 'utf8')).path).toBe(path)
})
it('打开生成译文或点击缓存翻译时恢复原文旁缺失的中文副本', async () => {
  const { dir, path, library, completion } = await setup()
  const session = await library.openFile(path)
  await library.translate(session.id); await completion
  const output = join(dir, 'original paper.中文译文.pdf')
  await unlink(output)
  expect((await library.openFile(path)).savedTranslationPath).toBe(output)
  await unlink(output)
  const cached = await library.translate(session.id)
  expect(cached.result?.savedTranslationPath).toBe(output)
  expect(await readFile(output)).toEqual(await readFile(await library.translatedFile(session.id)))
})
it('原文目录被移动后，译文仍成功且可读取，返回自动保存失败提示', async () => {
  const { dir, path, library, completion } = await setup()
  const folder = join(dir, 'source-folder'); await mkdir(folder)
  const original = join(folder, 'paper.pdf'); await writeFile(original, await readFile(path))
  const session = await library.openFile(original)
  await rename(folder, join(dir, 'moved-folder'))
  await library.translate(session.id)
  const job = await completion
  expect(job.status).toBe('completed')
  expect(job.result?.saveWarning).toMatch(/原文目录.*另存译文/)
  expect(job.result?.savedTranslationPath).toBeUndefined()
  expect((await readFile(await library.translatedFile(session.id))).subarray(0, 5).toString()).toBe('%PDF-')
})
it.each(['fresh', 'cached'])('自动保存期间重开含导入配对的原文，%s 译文显示与导出保持一致', async phase => {
  const { dir, path, library, completion } = await setup()
  const first = await library.openFile(path)
  if (phase === 'cached') { await library.translate(first.id); await completion }
  await library.importPair(path, await secondPdf(dir))
  let started!: () => void; const saving = new Promise<void>(resolve => { started = resolve })
  let release!: () => void; const block = new Promise<void>(resolve => { release = resolve })
  const save = translationFiles.saveBesideOriginal
  vi.spyOn(translationFiles, 'saveBesideOriginal').mockImplementation(async (...args) => { started(); await block; return save(...args) })
  const pending = library.translate(first.id)
  try { await saving; await library.openFile(path) } finally { release() }
  const result = await pending
  const finished = phase === 'cached' ? result : await completion
  expect(finished.result?.translationSource).toBe('generated')
  expect(library.getSession(first.id).translationKey).toBe(finished.result?.translationKey)
  expect(library.getSession(first.id).translationSource).toBe('generated')
  expect(await library.translatedFile(first.id)).toContain('translations')
})

it('纯排版升级重新生成 PDF 并保持译文复用，翻译策略升级才增加远端请求，旧批注版本保留', async () => {
  const { dir, store, path } = await setup()
  let requests = 0
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (body.messages[0].content.startsWith('You independently review')) {
      const items = JSON.parse(body.messages[1].content).paragraphs
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(items.map((item: any) => ({ paragraphId: item.paragraphId, issues: [] }))) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } }))
      return
    }
    const input = JSON.parse(body.messages[1].content.split('## Here is the input:')[1])
    requests++
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(input.map((item: any) => ({ id: item.id, output: '科学句子。' }))) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server)
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  await store.saveSettings({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'm', apiKey: 'test-key', qps: 1 })
  const service = (translation: string, layout: string) => {
    let done!: (job: TranslationJob) => void
    const completed = new Promise<TranslationJob>(resolve => { done = resolve })
    return { library: new LibraryService(store, { executable: process.execPath, prefixArgs: [resolve('tests/fixtures/engine.cjs'), 'api'] }, p => `test:${p}`, job => { if (job.status !== 'running') done(job) }, { translation, layout }), completed }
  }
  const first = service('policy-a', 'layout-a'); const original = await first.library.openFile(path)
  await first.library.translate(original.id); const a = await first.completed
  expect(a.status).toBe('completed'); expect(requests).toBe(1)
  const notes = new AnnotationStore(dir)
  await notes.add(original.id, { sourceKey: `translated:${a.result!.translationKey}`, quote: 'old', note: '旧版批注', color: 'yellow', anchors: [{ page: 1, rects: [{ x: .1, y: .1, width: .2, height: .03 }] }] })
  const next = service('policy-a', 'layout-b'); const reopened = await next.library.openFile(path)
  expect(reopened.translatedUrl).toBeUndefined()
  await next.library.translate(reopened.id); const b = await next.completed
  expect(b.status).toBe('completed'); expect(requests).toBe(1)
  expect(b.usage?.requests).toBe(0); expect(b.usage?.localCacheHits).toBe(1)
  expect(b.result!.translationKey).not.toBe(a.result!.translationKey)
  expect((await notes.list(original.id))[0].sourceKey).toBe(`translated:${a.result!.translationKey}`)
  const changed = service('policy-b', 'layout-b'); const changedDoc = await changed.library.openFile(path)
  expect(changedDoc.translatedUrl).toBeUndefined()
  await changed.library.translate(changedDoc.id); expect((await changed.completed).status).toBe('completed')
  expect(requests).toBe(2)
})

it('兼容旧研究规范的 PDF 只读回退保持原批注版本标识，不重写旧完成记录', async () => {
  const { dir, path, store } = await setup()
  const legacyLayout = '2.9.0-BabelDOC-0.6.3-research-layout-1'
  const library = new LibraryService(store, { executable: 'unavailable' }, p => `test:${p}`, () => {}, { translation: 'research-cache-v1-bcf26326f1fddf6b1ea78f1fbec552d20119fc567da008383c74906065907dea', layout: legacyLayout })
  const doc = await library.openFile(path)
  const oldKey = createHash('sha256').update(cacheKey(doc.id, await store.settings(), legacyLayout)).digest('hex')
  const folder = join(dir, 'translations', oldKey); await mkdir(folder, { recursive: true })
  const completed = join(folder, 'completed.json'); const before = JSON.stringify({ path, pages: 1 })
  await writeFile(completed, before)
  expect((await library.openFile(path)).translationKey).toBe(oldKey)
  const job = await library.translate(doc.id)
  expect(job.status).toBe('completed'); expect(job.result!.translationKey).toBe(oldKey)
  expect(await readFile(completed, 'utf8')).toBe(before)
})
