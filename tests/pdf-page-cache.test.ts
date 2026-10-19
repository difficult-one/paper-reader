import { expect, it, vi } from 'vitest'
import { WeightedLru, rasterDimensions, indexPageAnnotations, pdfDocumentCacheKey } from '../src/renderer/src/pdf-page-cache'
import type { PaperAnnotation } from '../src/shared/types'

it('只淘汰最久未用的非固定资源；拒绝超预算分配', () => {
  const disposed = vi.fn()
  const cache = new WeightedLru<string, number>(12)
  cache.set('visible', 1, 4, () => true, disposed)
  cache.set('old', 2, 4, () => false, disposed)
  cache.set('recent', 3, 4, () => false, disposed)
  cache.get('old')
  expect(cache.set('new', 4, 4)).toBe(true)
  expect(cache.get('recent')).toBeUndefined()
  expect(cache.get('visible')).toBe(1)
  expect(disposed).toHaveBeenCalledTimes(1)
  expect(cache.set('oversize', 5, 13)).toBe(false)
  expect(cache.bytes).toBe(12)
  cache.clear(); expect(cache.bytes).toBe(0)
})

it('绘制和选区固定资源不被淘汰；解锁后可以回收', () => {
  const cache = new WeightedLru<string, number>(8)
  let pinned = true
  cache.set('drawing', 1, 8, () => pinned)
  expect(cache.set('incoming', 2, 4)).toBe(false)
  expect(cache.bytes).toBe(8)
  pinned = false
  expect(cache.set('incoming', 2, 4)).toBe(true)
  expect(cache.bytes).toBe(4)
})

it('向上取整后仍遵守单页像素与剩余字节预算，支持高 DPR', () => {
  for (const width of [0.1, 595, 10000]) for (const height of [842, 20000]) {
    const size = rasterDimensions(width, height, 3, 1_000_000)
    expect(size.width * size.height).toBeLessThanOrEqual(250_000)
    expect(size.width).toBeGreaterThan(0)
  }
})

it('批注按页索引，未改变的页数组保持引用稳定', () => {
  const cache = new Map<number, PaperAnnotation[]>()
  const a = { id: 'a', anchors: [{ page: 2, rects: [] }, { page: 3, rects: [] }] } as unknown as PaperAnnotation
  const b = { id: 'b', anchors: [{ page: 4, rects: [] }] } as unknown as PaperAnnotation
  const first = indexPageAnnotations([a], cache)
  const second = indexPageAnnotations([a, b], first)
  expect(second.get(2)).toBe(first.get(2))
  expect(second.get(3)).toEqual([a])
  expect(second.get(4)).toEqual([b])
})

it('原文和译文保留相同原始 PDF ID 时仍隔离文字与尺寸缓存', () => {
  const original = pdfDocumentCacheKey('original', ['same-original-id', null])
  expect(pdfDocumentCacheKey('translated', ['same-original-id', 'modified'])).not.toBe(original)
  expect(pdfDocumentCacheKey('original', ['same-original-id', 'modified'])).not.toBe(original)
  expect(pdfDocumentCacheKey('another-source', ['same-original-id', null])).not.toBe(original)
})
