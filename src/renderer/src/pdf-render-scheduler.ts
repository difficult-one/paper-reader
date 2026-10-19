export interface PdfWork {
  priority?: number | (() => number)
  signal?: AbortSignal
  isCurrent?: () => boolean
  isReady?: () => boolean
  kind?: 'canvas' | 'text' | 'background'
  document?: string
  page?: number
  generation?: number
}
interface Pending { resume(): void; options: PdfWork; queued: number; detach(): void }
const pending = new Set<Pending>()
let frame = 0
const stats = { dispatches: 0, dispatchOverTarget: 0, maxDispatchMs: 0, canvas: 0, text: 0, background: 0 }
const budgetMs = 6

function run() {
  frame = 0
  const now = performance.now()
  let next: Pending | undefined; let best = Infinity
  for (const task of pending) {
    if (task.options.signal?.aborted || task.options.isCurrent?.() === false) {
      pending.delete(task); task.detach(); continue
    }
    if (task.options.isReady?.() === false) continue
    const priority = task.options.priority
    const score = (typeof priority === 'function' ? priority() : priority ?? 2) - Math.floor((now - task.queued) / 500)
    if (score < best) { best = score; next = task }
  }
  if (next) {
    pending.delete(next); next.detach()
    const start = performance.now()
    try { next.resume() } finally {
      const duration = performance.now() - start
      stats.dispatches++; stats[next.options.kind ?? 'canvas']++
      stats.maxDispatchMs = Math.max(stats.maxDispatchMs, duration)
      if (duration > budgetMs) stats.dispatchOverTarget++
      // PDF.js may defer actual execution again. This times dispatch only;
      // frame/long-task samples and Chrome traces measure real execution.
      if (pending.size && !frame) frame = requestAnimationFrame(run)
    }
  } else if (pending.size) frame = requestAnimationFrame(run)
}

export function schedulePdfRender(resume: () => void, options: PdfWork = {}): () => void {
  const cancel = () => {
    pending.delete(task); task.detach()
    if (!pending.size) { cancelAnimationFrame(frame); frame = 0 }
  }
  const task: Pending = { resume, options, queued: performance.now(), detach: () => options.signal?.removeEventListener('abort', cancel) }
  if (options.signal?.aborted) return () => {}
  pending.add(task); options.signal?.addEventListener('abort', cancel, { once: true })
  if (!frame) frame = requestAnimationFrame(run)
  return cancel
}

export const getPdfSchedulerStats = () => ({ ...stats, pending: pending.size, targetWorkMs: budgetMs })
