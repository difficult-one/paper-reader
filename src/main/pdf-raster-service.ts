import type { PdfRasterRequest, PdfRasterResult } from '../shared/pdf-raster'

interface Waiter { owner: string; resolve(value: PdfRasterResult): void; reject(error: Error): void }
export interface PdfRasterProcess { postMessage(message: unknown): void; on(event: string, listener: (...args: any[]) => void): unknown; once(event: string, listener: (...args: any[]) => void): unknown; terminate(): unknown }
interface Session { worker: PdfRasterProcess; ready: Promise<void>; owners: Set<string>; pending: Map<string, Waiter> }
export class PdfRasterService {
  private sessions = new Map<string, Session>()
  private owners = new Map<string, Session>()
  private closing = new Set<Promise<void>>()
  private opening = new Map<string, { cancelled: boolean }>()
  constructor(private options: { resolvePdf(url: string): string | undefined; assets: string; spawn(path: string, assets: string): PdfRasterProcess }) {}
  async open(owner: string, url: string) {
    const path = this.options.resolvePdf(url)
    if (!path || typeof owner !== 'string' || !owner || owner.length > 100 || this.owners.has(owner) || this.opening.has(owner)) throw new Error('PDF 绘制会话无效。')
    const token = { cancelled: false }; this.opening.set(owner, token)
    try {
      let session = this.sessions.get(url)
      if (!session) {
        while (this.sessions.size + this.closing.size >= 4 && this.closing.size) await Promise.race(this.closing)
        if (token.cancelled) throw new Error('PDF 绘制会话已关闭。')
        if (this.sessions.size + this.closing.size >= 4) throw new Error('同时打开的 PDF 绘制会话过多。')
        if (this.owners.has(owner)) throw new Error('PDF 绘制会话无效。')
        session = this.sessions.get(url)
      }
      if (!session) {
        const worker = this.options.spawn(path, this.options.assets)
        let ready!: () => void; let failed!: (error: Error) => void
        const readyPromise = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
        session = { worker, ready: readyPromise, owners: new Set(), pending: new Map() }
        const current = session
        const failure = (error: Error) => {
          failed(error)
          for (const waiter of current.pending.values()) waiter.reject(error)
          current.pending.clear()
          for (const id of current.owners) if (this.owners.get(id) === current) this.owners.delete(id)
          if (this.sessions.get(url) === current) this.sessions.delete(url)
        }
        worker.on('message', message => {
          if (message.type === 'ready') { ready(); return }
          if (message.type === 'fatal') { failure(new Error(message.error)); void worker.terminate(); return }
          const waiter = current.pending.get(message.id)
          if (!waiter) return
          current.pending.delete(message.id)
          if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve({ png: message.png, ...(message.timings ? { timings: message.timings } : {}) })
        })
        worker.on('error', failure)
        worker.on('exit', () => failure(new Error('PDF 绘制线程已关闭。')))
        this.sessions.set(url, session)
      }
      session.owners.add(owner); this.owners.set(owner, session)
      await session.ready
      if (token.cancelled) throw new Error('PDF 绘制会话已关闭。')
    } finally { if (this.opening.get(owner) === token) this.opening.delete(owner) }
  }
  render(owner: string, request: PdfRasterRequest): Promise<PdfRasterResult> {
    const session = this.owners.get(owner)
    if (!session || !request || typeof request.id !== 'string' || !request.id || request.id.length > 120 || session.pending.has(request.id)
      || !Number.isInteger(request.page) || request.page < 1 || !Number.isFinite(request.scale) || request.scale <= 0 || request.scale > 100
      || !Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 1 || request.height < 1 || request.width * request.height > 8_000_000
      || !Number.isFinite(request.priority) || Math.abs(request.priority) > 10 || session.pending.size >= 64) return Promise.reject(new Error('PDF 绘制请求无效。'))
    return new Promise((resolve, reject) => {
      session.pending.set(request.id, { owner, resolve, reject })
      session.worker.postMessage({ type: 'render', ...request })
    })
  }
  prioritize(owner: string, id: string, priority: number) {
    const session = this.owners.get(owner); const waiter = session?.pending.get(id)
    if (!waiter || waiter.owner !== owner || !Number.isFinite(priority) || Math.abs(priority) > 10) return
    session!.worker.postMessage({ type: 'priority', id, priority })
  }
  cancel(owner: string, id: string) {
    const session = this.owners.get(owner); const waiter = session?.pending.get(id)
    if (!waiter || waiter.owner !== owner) return
    session!.pending.delete(id); waiter.reject(new Error('PDF 绘制已取消。'))
    session!.worker.postMessage({ type: 'cancel', id })
  }
  async close(owner: string) {
    const opening = this.opening.get(owner)
    if (opening) { opening.cancelled = true; this.opening.delete(owner) }
    const session = this.owners.get(owner)
    if (!session) return
    for (const [id, waiter] of session.pending) if (waiter.owner === owner) this.cancel(owner, id)
    this.owners.delete(owner); session.owners.delete(owner)
    if (!session.owners.size) {
      for (const [url, value] of this.sessions) if (value === session) this.sessions.delete(url)
      const closed = new Promise<void>(resolve => {
        const timer = setTimeout(() => { void session.worker.terminate() }, 5000)
        session.worker.once('exit', () => { clearTimeout(timer); resolve() })
        session.worker.postMessage({ type: 'close' })
      })
      this.closing.add(closed)
      try { await closed } finally { this.closing.delete(closed) }
    }
  }
  async shutdown() {
    for (const token of this.opening.values()) token.cancelled = true
    this.opening.clear()
    await Promise.all([...this.owners.keys()].map(owner => this.close(owner))); await Promise.all(this.closing)
  }
}
