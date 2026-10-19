import { WeightedLru } from './pdf-page-cache'
import { getPdfSchedulerStats } from './pdf-render-scheduler'

const parameters = new URLSearchParams(location.search)
const enabled = (name: string) => parameters.get(`pdf-${name}`) !== 'off'
const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
export const pdfPerformance = {
  priority: enabled('priority'), preview: false, deferText: enabled('defer-text'),
  worker: enabled('worker'),
  cacheBytes: (parameters.get('pdf-cache-mib') === '64' || memory <= 4 ? 64 : 128) * 1024 * 1024,
  settleMs: 130,
}
export const rasterCache = new WeightedLru<HTMLCanvasElement, HTMLCanvasElement>(pdfPerformance.cacheBytes)
export const textCache = new WeightedLru<string, Awaited<ReturnType<import('pdfjs-dist').PDFPageProxy['getTextContent']>>>(16 * 1024 * 1024)
export const sizeCache = new WeightedLru<string, { width: number; height: number }[]>(1024 * 1024)
export let activePdfPane = 'left'
export const activatePdfPane = (side: string) => { activePdfPane = side }
export const pdfStats = { canvasRenders: 0, textRenders: 0, cacheHits: 0, evictions: 0, previews: 0 }
Object.defineProperty(window, '__pdfPerformance', { configurable: true, get: () => ({
  ...pdfStats, rasterBytes: rasterCache.bytes, rasterBudget: rasterCache.budget,
  textBytes: textCache.bytes, textBudget: textCache.budget, scheduler: getPdfSchedulerStats(), config: pdfPerformance,
}) })
