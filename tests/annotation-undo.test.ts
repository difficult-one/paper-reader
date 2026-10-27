import { expect, it } from 'vitest'
import { AnnotationUndoHistory } from '../src/renderer/src/annotation-undo'
import type { PaperAnnotation } from '../src/shared/types'

const note = (id = 'a', text = 'before'): PaperAnnotation => ({ id, sourceKey: 'original', quote: 'selected text', anchors: [{ page: 1, rects: [{ x: .1, y: .1, width: .5, height: .02 }] }], note: text, color: 'yellow', createdAt: 1, updatedAt: 1 })
it('records inverse annotation operations in order and keeps snapshots independent', () => {
  const history = new AnnotationUndoHistory()
  const first = note()
  history.record('remove', first)
  first.note = 'changed'
  expect(history.latest?.annotation.note).toBe('before')
  history.record('restore', note('deleted'))
  const latest = history.latest!
  expect(latest.kind).toBe('restore')
  expect(history.latest?.annotation.id).toBe('deleted')
  history.complete(latest)
  expect(history.latest?.kind).toBe('remove')
  history.clear()
  expect(history.latest).toBeUndefined()
})
it('groups consecutive text edits but keeps color changes and different notes separate', () => {
  const history = new AnnotationUndoHistory()
  history.record('edit', note('a', 'before'), 100, true)
  history.record('edit', note('a', 'b'), 200, true)
  expect(history.latest?.annotation.note).toBe('before')
  history.record('edit', { ...note('a', 'bc'), color: 'green' }, 250)
  expect(history.latest?.annotation.color).toBe('green')
  history.complete(history.latest!)
  expect(history.latest?.annotation.note).toBe('before')
  history.record('edit', note('b'), 300)
  history.complete(history.latest!)
  expect(history.latest?.annotation.id).toBe('a')
})
it('does not discard a newer operation when an older undo completes', () => {
  const history = new AnnotationUndoHistory()
  history.record('remove', note('a'))
  const pending = history.latest!
  history.record('remove', note('b'))
  history.complete(pending)
  expect(history.latest?.annotation.id).toBe('b')
  history.complete(history.latest!)
  expect(history.latest).toBeUndefined()
})
it('keeps earlier undo operations valid after a deleted note is recreated with a new id', () => {
  const history = new AnnotationUndoHistory()
  history.record('remove', note('old'))
  history.record('edit', note('old'))
  history.record('restore', note('old'))
  const restored = history.latest!
  history.remapId('old', 'restored')
  history.complete(restored)
  expect(history.latest?.annotation.id).toBe('restored')
  history.complete(history.latest!)
  expect(history.latest?.annotation.id).toBe('restored')
})
it('starts a new text-edit group after undo instead of absorbing earlier completed edits', () => {
  const history = new AnnotationUndoHistory()
  history.record('edit', note('a', ''), 100, true)
  history.record('edit', note('a', 'kept text'), 150)
  history.complete(history.latest!)
  history.record('edit', note('a', 'kept text'), 200, true)
  expect(history.latest?.annotation.note).toBe('kept text')
})
