import type { PaperAnnotation } from '../../shared/types'

export interface AnnotationUndoEntry { kind: 'remove' | 'restore' | 'edit'; annotation: PaperAnnotation; time: number; groupText: boolean }
export class AnnotationUndoHistory {
  private entries: AnnotationUndoEntry[] = []
  get latest() { return this.entries.at(-1) }
  record(kind: AnnotationUndoEntry['kind'], annotation: PaperAnnotation, time = Date.now(), groupText = false) {
    const previous = this.latest
    if (groupText && previous?.groupText && kind === 'edit' && previous.kind === 'edit' && previous.annotation.id === annotation.id && previous.annotation.color === annotation.color && time - previous.time < 750) {
      previous.time = time; return
    }
    this.entries.push({ kind, annotation: structuredClone(annotation), time, groupText })
    if (this.entries.length > 100) this.entries.shift()
  }
  complete(entry: AnnotationUndoEntry) {
    const index = this.entries.indexOf(entry)
    if (index >= 0) {
      this.entries.splice(index, 1)
      if (this.latest) this.latest.groupText = false
    }
  }
  remapId(previous: string, next: string) {
    for (const entry of this.entries) if (entry.annotation.id === previous) entry.annotation.id = next
  }
  clear() { this.entries = [] }
}
