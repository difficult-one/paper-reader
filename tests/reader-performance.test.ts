import { expect, it } from 'vitest'
import { summarizeFrames, performanceFailures } from '../src/shared/reader-performance'

it('保留原始时序，用最近秩计算 P95/P99 和慢帧占比', () => {
  const frames = [...Array(998).fill(16.7), 55, 110]
  const snapshot = [...frames]
  expect(summarizeFrames(frames)).toMatchObject({ p95FrameMs: 16.7, p99FrameMs: 16.7, framesOver50ms: 2, framesOver100ms: 1 })
  expect(frames).toEqual(snapshot)
  expect(performanceFailures({ frames, longTasks: [], inputLatency: [] })).toEqual(expect.arrayContaining([expect.stringContaining('50 ms'), expect.stringContaining('100 ms')]))
})

it('帧耗时和长任务真正阻止发布，高刷新率使用独立阈值', () => {
  expect(performanceFailures({ frames: Array(100).fill(25), longTasks: [60], inputLatency: [70] })).toHaveLength(3)
  expect(performanceFailures({ frames: Array(100).fill(16.7), longTasks: [], inputLatency: [12] }, 120).length).toBeGreaterThan(0)
  expect(performanceFailures({ frames: Array(100).fill(16.7), longTasks: [], inputLatency: [12] })).toEqual([])
})

it('空采样不能伪装成通过', () => {
  expect(performanceFailures({ frames: [], longTasks: [], inputLatency: [] }).join(' ')).toContain('采样')
})

it('十分钟高刷新率采样超过二十万帧时仍可汇总', () => {
  expect(summarizeFrames(Array(200_000).fill(3.4))).toMatchObject({ frames: 200_000, maxFrameMs: 3.4 })
})
