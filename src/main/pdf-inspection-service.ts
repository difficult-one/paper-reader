import { Worker } from 'node:worker_threads'
import type { PdfInfo } from '../shared/types'

// Reuse PDF.js in one worker, and serialize inspection so repeated open/import
// actions cannot consume an unbounded number of parsing threads.
export class PdfInspectionService {
  private worker: Worker | undefined
  private tail = Promise.resolve()
  private closed = false
  constructor(private workerUrl: URL) {}

  inspect(path: string): Promise<PdfInfo> {
    const result = this.tail.then(() => this.run(path))
    this.tail = result.then(() => {}, () => {})
    return result
  }
  private run(path: string): Promise<PdfInfo> {
    if (this.closed) return Promise.reject(new Error('PDF 检查已关闭。'))
    let worker = this.worker
    if (!worker) {
      worker = this.worker = new Worker(this.workerUrl)
      const current = worker
      const clear = () => { if (this.worker === current) this.worker = undefined }
      worker.on('error', clear); worker.once('exit', clear)
    }
    const current = worker
    return new Promise((resolve, reject) => {
      const cleanup = () => { current.off('message', message); current.off('error', error); current.off('exit', exit) }
      const message = (result: { value?: PdfInfo; error?: string }) => {
        cleanup()
        if (result.value) resolve(result.value)
        else reject(new Error(result.error ?? 'PDF 检查失败。'))
      }
      const error = (failure: Error) => { cleanup(); reject(failure) }
      const exit = () => error(new Error('PDF 检查线程已关闭，请重新打开文件。'))
      current.once('message', message); current.once('error', error); current.once('exit', exit)
      try { current.postMessage(path) } catch (failure) { error(failure as Error) }
    })
  }
  async shutdown() {
    this.closed = true
    await this.worker?.terminate()
    await this.tail
  }
}
