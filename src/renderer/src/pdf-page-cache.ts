import type { PaperAnnotation } from '../../shared/types'

export const pdfDocumentCacheKey = (source: string, fingerprints: (string | null)[]) => JSON.stringify([source, ...fingerprints])

interface Entry<V> { value: V; bytes: number; pinned(): boolean; dispose(): void }
export class WeightedLru<K, V> {
  private entries = new Map<K, Entry<V>>()
  bytes = 0
  constructor(readonly budget: number) {}
  availableBytes() {
    let pinnedBytes = 0
    for (const entry of this.entries.values()) if (entry.pinned()) pinnedBytes += entry.bytes
    return this.budget - pinnedBytes
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, entry)
    return entry.value
  }
  set(key: K, value: V, bytes: number, pinned = () => false, dispose = () => {}): boolean {
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.budget) return false
    const previous = this.entries.get(key)
    let needed = this.bytes - (previous?.bytes ?? 0) + bytes - this.budget
    const victims: K[] = []
    for (const [candidate, entry] of this.entries) {
      if (needed <= 0) break
      if (candidate !== key && !entry.pinned()) { victims.push(candidate); needed -= entry.bytes }
    }
    if (needed > 0) return false
    for (const victim of victims) this.delete(victim)
    this.delete(key)
    this.entries.set(key, { value, bytes, pinned, dispose }); this.bytes += bytes
    return true
  }
  delete(key: K) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key); this.bytes -= entry.bytes; entry.dispose()
  }
  clear() { for (const key of this.entries.keys()) this.delete(key) }
}

export function rasterDimensions(width: number, height: number, dpr: number, availableBytes = 32_000_000) {
  const pixels = Math.max(1, Math.min(8_000_000, Math.floor(availableBytes / 4)))
  const ratio = Math.min(dpr || 1, 2, Math.sqrt(pixels / Math.max(1, width * height)))
  let w = Math.max(1, Math.floor(width * ratio)); let h = Math.max(1, Math.floor(height * ratio))
  if (w * h > pixels) { w = Math.min(w, pixels); h = Math.max(1, Math.floor(pixels / w)) }
  return { width: w, height: h, ratio: Math.min(w / width, h / height) }
}

export function indexPageAnnotations(annotations: PaperAnnotation[], previous: Map<number, PaperAnnotation[]> = new Map()) {
  const result = new Map<number, PaperAnnotation[]>()
  for (const annotation of annotations) for (const page of new Set(annotation.anchors.map(anchor => anchor.page))) {
    const list = result.get(page) ?? []; list.push(annotation); result.set(page, list)
  }
  for (const [page, list] of result) {
    const old = previous.get(page)
    if (old?.length === list.length && list.every((annotation, i) => annotation === old[i])) result.set(page, old)
  }
  return result
}
