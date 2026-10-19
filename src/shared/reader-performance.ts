export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}
export function summarizeFrames(frames: number[]) {
  return { frames: frames.length, p95FrameMs: percentile(frames, .95), p99FrameMs: percentile(frames, .99),
    maxFrameMs: frames.length ? frames.reduce((maximum, value) => Math.max(maximum, value), 0) : null,
    framesOver50ms: frames.filter(value => value > 50).length,
    framesOver100ms: frames.filter(value => value > 100).length }
}
export function performanceFailures(data: { frames: number[]; longTasks: number[]; inputLatency: number[] }, refreshHz = 60): string[] {
  const metrics = summarizeFrames(data.frames); const failures: string[] = []
  const p95Limit = refreshHz <= 60 ? 20 : 1000 / refreshHz * 1.2
  const p99Limit = refreshHz <= 60 ? 33.4 : 1000 / refreshHz * 2.004
  if (!data.frames.length) return ['缺少帧采样']
  if (metrics.p95FrameMs! > p95Limit) failures.push(`P95 帧间隔 ${metrics.p95FrameMs} > ${p95Limit} ms`)
  if (metrics.p99FrameMs! > p99Limit) failures.push(`P99 帧间隔 ${metrics.p99FrameMs} > ${p99Limit} ms`)
  if (metrics.framesOver50ms / metrics.frames > .001) failures.push('超过 50 ms 帧占比 > 0.1%')
  if (metrics.framesOver100ms) failures.push('出现超过 100 ms 帧；需以 trace 说明来源')
  if (data.longTasks.length / metrics.frames > .001 || data.longTasks.some(value => value > 100)) failures.push('长任务超过帧数 0.1% 或出现 >100 ms 任务')
  const latency = percentile(data.inputLatency, .95)
  if (latency !== null && latency >= 50) failures.push(`输入反馈 P95 ${latency} >= 50 ms`)
  return failures
}
