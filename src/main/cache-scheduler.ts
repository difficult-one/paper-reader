export interface ColdStartOptions { enabled?: boolean; minPrefixBytes?: number }
interface Group { completed: number; active: boolean; warm: boolean; waiters: Set<() => void> }

// This gate only delays existing work. Rate limiting, worker limits and retries stay in the engine.
export class CacheScheduler {
  private groups = new Map<string, Group>()
  private admission: Promise<void> = Promise.resolve()
  private lastAdmitted = -Infinity
  constructor(private options: ColdStartOptions = {}, private qps = 2, private paceWhenDisabled = false) {}
  private async admit(signal: AbortSignal) {
    const next = this.admission.catch(() => {}).then(async () => {
      signal.throwIfAborted()
      const delay = Math.max(0, this.lastAdmitted + 1000 / this.qps - performance.now())
      if (delay > 0) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delay)
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
      })
      signal.throwIfAborted(); this.lastAdmitted = performance.now()
    })
    this.admission = next
    return next
  }
  async acquire(key: string, prefixBytes: number, signal: AbortSignal, knownTemplate = true) {
    signal.throwIfAborted()
    const started = performance.now()
    if (!this.options.enabled) { if (this.paceWhenDisabled) await this.admit(signal); return { waitMs: performance.now() - started, complete(_hit = false) {} } }
    if (!knownTemplate || prefixBytes < (this.options.minPrefixBytes ?? 2048)) { await this.admit(signal); return { waitMs: performance.now() - started, complete(_hit = false) {} } }
    let group = this.groups.get(key)
    if (!group) { group = { completed: 0, active: false, warm: false, waiters: new Set() }; this.groups.set(key, group) }
    while (!group.warm && group.completed < 2 && group.active) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); group!.waiters.delete(wake); resolve() }
        const abort = () => { group!.waiters.delete(wake); reject(signal.reason) }
        group!.waiters.add(wake); signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
      })
      signal.throwIfAborted()
    }
    const constrained = !group.warm && group.completed < 2
    if (constrained) group.active = true
    let released = false
    const complete = (hit = false) => {
      if (released || !constrained) return
      released = true; group!.completed++; group!.active = false; group!.warm ||= hit
      for (const wake of [...group!.waiters]) wake()
    }
    try { await this.admit(signal) } catch (error) { complete(); throw error }
    return { waitMs: performance.now() - started, complete }
  }
}
