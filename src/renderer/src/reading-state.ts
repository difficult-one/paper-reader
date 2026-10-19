import type { DocumentSession, ReadingState } from '../../shared/types'

export const freshReading = (): ReadingState => ({ left: { page: 1, fraction: 0 }, right: { page: 1, fraction: 0 }, zoom: 1, rightZoom: 1, split: 50, linked: true })

export function restoreReading(next: DocumentSession, previous: DocumentSession | null, current: ReadingState, forceParallel = false): ReadingState {
  const sameDocument = previous?.id === next.id
  const saved = sameDocument ? current : next.reading ?? freshReading()
  const versionChanged = (sameDocument && previous.translationKey !== next.translationKey) || (saved.translationKey !== undefined && saved.translationKey !== next.translationKey)
  const linked = saved.linked && (!next.translatedUrl || next.pages === next.translatedPages)
  return {
    ...saved,
    mode: forceParallel ? 'parallel' : saved.mode === 'translated' && !next.translatedUrl ? 'original' : saved.mode ?? (next.language === 'zh' ? 'original' : 'parallel'),
    right: versionChanged ? linked ? saved.left : { page: 1, fraction: 0 } : saved.right,
    rightZoom: saved.rightZoom ?? saved.zoom, linked, translationKey: next.translationKey
  }
}
