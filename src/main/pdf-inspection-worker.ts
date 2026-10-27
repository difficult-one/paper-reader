import { parentPort } from 'node:worker_threads'
import { inspectPdf } from './engine'

parentPort!.on('message', async (path: string) => {
  try { parentPort!.postMessage({ value: await inspectPdf(path) }) }
  catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : 'PDF 检查失败。' }) }
})
