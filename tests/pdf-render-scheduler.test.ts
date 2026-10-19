import { afterEach, expect, it, vi } from 'vitest'
import { schedulePdfRender, getPdfSchedulerStats } from '../src/renderer/src/pdf-render-scheduler'

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
const tick = () => {
  const current = [...frames.values()]
  frames.clear()
  current.forEach(callback => callback(0))
}
afterEach(() => { while (frames.size) tick() })

it('双栏页面竞争时每帧只放行一段 PDF 绘制，为输入与联动保留时间', () => {
  const rendered: string[] = []
  schedulePdfRender(() => rendered.push('left'))
  schedulePdfRender(() => rendered.push('right'))
  schedulePdfRender(() => rendered.push('prefetch'))
  expect(rendered).toEqual([])
  tick(); expect(rendered).toEqual(['left'])
  tick(); expect(rendered).toEqual(['left', 'right'])
  tick(); expect(rendered).toEqual(['left', 'right', 'prefetch'])
  expect(frames.size).toBe(0)
})

it('离屏或缩放取消的页面不再绘制，也不阻塞后续页面', () => {
  const rendered: string[] = []
  const cancel = schedulePdfRender(() => rendered.push('cancelled'))
  schedulePdfRender(() => rendered.push('visible'))
  cancel()
  tick(); expect(rendered).toEqual(['visible'])
  const cancelLast = schedulePdfRender(() => rendered.push('closed'))
  cancelLast()
  expect(frames.size).toBe(0)
  tick(); expect(rendered).toEqual(['visible'])
})

it('长页继续绘制时排到已等待页面之后，不在同帧重复执行', () => {
  const rendered: string[] = []
  schedulePdfRender(() => {
    rendered.push('left-1')
    schedulePdfRender(() => rendered.push('left-2'))
  })
  schedulePdfRender(() => rendered.push('right'))
  tick(); expect(rendered).toEqual(['left-1'])
  tick(); expect(rendered).toEqual(['left-1', 'right'])
  tick(); expect(rendered).toEqual(['left-1', 'right', 'left-2'])
  expect(frames.size).toBe(0)
})

it('排队期间动态提升可见页，并让文本和画布共享同一帧队列', () => {
  const rendered: string[] = []
  let priority = 3
  schedulePdfRender(() => rendered.push('prefetch'), { priority: () => priority })
  schedulePdfRender(() => rendered.push('text'), { priority: 1, kind: 'text' })
  schedulePdfRender(() => rendered.push('visible'), { priority: 0 })
  tick(); expect(rendered).toEqual(['visible'])
  priority = 0
  tick(); expect(rendered).toEqual(['visible', 'prefetch'])
  tick(); expect(rendered).toEqual(['visible', 'prefetch', 'text'])
})

it('取消信号和旧 generation 不能启动工作或阻塞队列', () => {
  const rendered: string[] = []
  const controller = new AbortController()
  schedulePdfRender(() => rendered.push('aborted'), { signal: controller.signal })
  schedulePdfRender(() => rendered.push('stale'), { isCurrent: () => false })
  schedulePdfRender(() => rendered.push('current'))
  controller.abort(); tick()
  expect(rendered).toEqual(['current'])
  expect(getPdfSchedulerStats().pending).toBe(0)
})

it('绘图进程忙时保留尚未分配画布的工作，仍允许其他文档与文字执行', () => {
  let ready = false
  const rendered: string[] = []
  const cancel = schedulePdfRender(() => rendered.push('busy-document'), { priority: 0, isReady: () => ready })
  schedulePdfRender(() => rendered.push('other-document'), { priority: 1 })
  try {
    tick(); expect(rendered).toEqual(['other-document'])
    tick(); expect(rendered).toEqual(['other-document'])
    expect(frames.size).toBe(1)
    ready = true; tick(); expect(rendered).toEqual(['other-document', 'busy-document'])
    expect(frames.size).toBe(0)
  } finally { cancel() }
})

it('等待时间提升低优先级任务以避免持续可见任务使另一栏饥饿', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  const rendered: string[] = []
  schedulePdfRender(() => rendered.push('background'), { priority: 4 })
  clock.mockReturnValue(2500)
  schedulePdfRender(() => rendered.push('visible'), { priority: 0 })
  tick(); expect(rendered).toEqual(['background'])
  tick(); clock.mockRestore()
})
