import type { AnnotationDraft, HighlightColor, PaperAnnotation } from '../shared/types'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from './store'
const colors: HighlightColor[] = ['yellow', 'green', 'blue', 'pink']
function validate(draft: AnnotationDraft) {
  if (!draft || !/^(original|translated:[a-f0-9]{64})$/.test(draft.sourceKey) || typeof draft.quote !== 'string' || !draft.quote.trim() || draft.quote.length > 12000 || typeof draft.note !== 'string' || draft.note.length > 12000 || !colors.includes(draft.color)) throw new Error('批注内容或颜色无效。')
  if (!Array.isArray(draft.anchors) || !draft.anchors.length || draft.anchors.length > 100) throw new Error('批注位置无效。')
  for (const anchor of draft.anchors) {
    if (!Number.isInteger(anchor.page) || anchor.page < 1 || !Array.isArray(anchor.rects) || !anchor.rects.length || anchor.rects.length > 2000) throw new Error('批注页码或位置无效。')
    for (const r of anchor.rects) if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.00001 || r.y + r.height > 1.00001) throw new Error('批注坐标超出页面。')
  }
}
export class AnnotationStore {
  private pending = new Map<string, Promise<unknown>>()
  constructor(readonly directory: string) {}
  private path(id: string) { if (!/^[a-f0-9]{1,64}$/.test(id)) throw new Error('文档标识无效。'); return join(this.directory, 'annotations', `${id}.json`) }
  private async mutate<T>(documentId: string, action: (notes: PaperAnnotation[]) => T): Promise<T> {
    const path = this.path(documentId)
    const operation = (this.pending.get(documentId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const notes = await readJson<PaperAnnotation[]>(path, [])
      const result = action(notes)
      await writeJson(path, notes)
      return result
    })
    this.pending.set(documentId, operation)
    try { return await operation } finally { if (this.pending.get(documentId) === operation) this.pending.delete(documentId) }
  }
  async list(documentId: string): Promise<PaperAnnotation[]> {
    const path = this.path(documentId); await this.pending.get(documentId)
    return readJson(path, [])
  }
  async flush(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending.values()]) }
  async add(documentId: string, draft: AnnotationDraft): Promise<PaperAnnotation> {
    validate(draft)
    return this.mutate(documentId, notes => {
      const annotation = { sourceKey: draft.sourceKey, quote: draft.quote.trim(), note: draft.note, color: draft.color, anchors: structuredClone(draft.anchors), id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() }
      notes.push(annotation); return annotation
    })
  }
  async edit(documentId: string, id: string, changes: { note: string; color: HighlightColor }): Promise<PaperAnnotation> {
    if (!changes || typeof changes.note !== 'string' || changes.note.length > 12000 || !colors.includes(changes.color)) throw new Error('批注内容无效。')
    return this.mutate(documentId, notes => {
      const note = notes.find(note => note.id === id)
      if (!note) throw new Error('这条批注已不存在。')
      note.note = changes.note; note.color = changes.color; note.updatedAt = Date.now()
      return note
    })
  }
  async remove(documentId: string, id: string): Promise<void> {
    return this.mutate(documentId, notes => { const index = notes.findIndex(note => note.id === id); if (index >= 0) notes.splice(index, 1) })
  }
}
