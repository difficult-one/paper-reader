import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnnotationStore } from '../src/main/annotations'
import type { AnnotationDraft } from '../src/shared/types'
import { normalizeSelectionRects } from '../src/shared/selection'
import { detectLanguage } from '../src/shared/core'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'reader-notes-')); dirs.push(dir); return { dir, notes: new AnnotationStore(dir) } }
const draft: AnnotationDraft = { sourceKey: 'original', quote: '研究结果与实验条件', note: '需要重点核实', color: 'yellow', anchors: [{ page: 2, rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.03 }] }] }
it('高亮和中文备注跨重启保存，编辑和删除不影响其他记录', async () => {
  const { notes, dir } = await setup()
  const first = await notes.add('abc', draft)
  const second = await notes.add('abc', { ...draft, quote: '另一段' })
  const restarted = new AnnotationStore(dir)
  expect((await restarted.list('abc')).map(a => a.quote)).toEqual(['研究结果与实验条件', '另一段'])
  await restarted.edit('abc', first.id, { note: '核对后已确认', color: 'green' })
  expect((await restarted.list('abc'))[0].note).toBe('核对后已确认')
  await restarted.remove('abc', first.id)
  expect((await restarted.list('abc')).map(a => a.id)).toEqual([second.id])
})
it('连续创建多条批注不会因并发写入丢失记录', async () => {
  const { notes } = await setup()
  await Promise.all(Array.from({ length: 8 }, (_, i) => notes.add('abc', { ...draft, quote: `第${i}条` })))
  expect(await notes.list('abc')).toHaveLength(8)
})
it('文档批注相互隔离，译文批注绑定具体翻译版本', async () => {
  const { notes } = await setup()
  await notes.add('abc', draft)
  await notes.add('abc', { ...draft, sourceKey: `translated:${'a'.repeat(64)}` })
  expect(await notes.list('def')).toEqual([])
  expect((await notes.list('abc')).filter(a => a.sourceKey === 'original')).toHaveLength(1)
})
it('拒绝路径穿越、无效坐标和空批注', async () => {
  const { notes } = await setup()
  await expect(notes.add('../abc', draft)).rejects.toThrow()
  await expect(notes.add('abc', { ...draft, quote: '' })).rejects.toThrow()
  await expect(notes.add('abc', { ...draft, anchors: [{ page: -1, rects: [] }] })).rejects.toThrow()
  await expect(notes.add('abc', { ...draft, anchors: [{ page: 1, rects: [{ x: -0.3, y: 0, width: 1, height: 1 }] }] })).rejects.toThrow()
})
it('高亮坐标独立于窗口大小和缩放比例，并裁去页外区域', () => {
  expect(normalizeSelectionRects({ left: 100, top: 50, width: 400, height: 600 }, [{ left: 140, top: 110, width: 100, height: 30 }])).toEqual([{ x: 0.1, y: 0.1, width: 0.25, height: 0.05 }])
  expect(normalizeSelectionRects({ left: 0, top: 0, width: 800, height: 1200 }, [{ left: 80, top: 120, width: 200, height: 60 }])).toEqual([{ x: 0.1, y: 0.1, width: 0.25, height: 0.05 }])
  expect(normalizeSelectionRects({ left: 0, top: 0, width: 100, height: 100 }, [{ left: 200, top: 200, width: 10, height: 10 }])).toEqual([])
})
it('中文论文可自动进入中文阅读，英文摘要不会改变明确的中文正文识别', () => {
  expect(detectLanguage('中文学术论文的研究方法和实验结果，主要结论与未来工作。Abstract')).toBe('zh')
  expect(detectLanguage('A scientific paper about reading and translation.')).toBe('en')
  expect(detectLanguage('42 = x')).toBe('unknown')
})
