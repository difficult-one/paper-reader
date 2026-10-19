import { expect, it } from 'vitest'
import type { DocumentSession, ReadingState } from '../src/shared/types'
import { restoreReading } from '../src/renderer/src/reading-state'

const document = (id: string, translationKey: string): DocumentSession => ({ id, translationKey, name: 'paper.pdf', path: 'paper.pdf', pages: 4, translatedPages: 4, hasText: true, language: 'en', originalUrl: 'original', translatedUrl: 'translated' })
const saved: ReadingState = { left: { page: 2, fraction: .1 }, right: { page: 3, fraction: .5 }, zoom: 1, split: 50, linked: false, mode: 'parallel' }
it('打开另一篇已有配对时保留它自己的右侧阅读位置', () => {
  const next = { ...document('next', 'right'), reading: saved }
  expect(restoreReading(next, document('previous', 'another'), { ...saved, right: { page: 1, fraction: 0 } }, true).right).toEqual({ page: 3, fraction: .5 })
})
it('同篇论文切换导入和生成版本时重置独立右侧位置', () => {
  expect(restoreReading(document('same', 'generated'), document('same', 'imported'), saved).right).toEqual({ page: 1, fraction: 0 })
  expect(restoreReading(document('same', 'imported'), document('same', 'generated'), saved).right).toEqual({ page: 1, fraction: 0 })
})
it('同篇论文切换版本时联动位置跟随原文，重启遇到不同版本也重置', () => {
  expect(restoreReading(document('same', 'generated'), document('same', 'imported'), { ...saved, linked: true }).right).toEqual({ page: 2, fraction: .1 })
  const next = { ...document('same', 'imported'), reading: { ...saved, translationKey: 'generated' } }
  expect(restoreReading(next, null, saved).right).toEqual({ page: 1, fraction: 0 })
})
