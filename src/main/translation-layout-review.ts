import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { LAYOUT_VERSION } from './cache-versions'

export interface LayoutArtifact { pdfPath: string; qualityReportPath: string }
export async function verifyHumanLayoutReview(cases: { documentId: string; documentSha256?: string }[], policy: string, files: LayoutArtifact[], review: { method?: string; status?: string; reviewer?: string; reviewedAt?: string; outputHashes?: string[] } | null) {
  const reasons: string[] = []
  const expected = new Map(cases.map(sample => [sample.documentId, sample.documentSha256]))
  if (!review || review.method !== 'human' || review.status !== 'passed' || !review.reviewer?.trim() || !review.reviewedAt || !Number.isFinite(Date.parse(review.reviewedAt)) || !Array.isArray(review.outputHashes)) return { passed: false, reasons: ['missing-human-layout-review'], verifiedDocuments: [] as string[] }
  if (review.outputHashes.length !== expected.size || new Set(review.outputHashes).size !== review.outputHashes.length || files.length !== expected.size) reasons.push('incomplete-layout-artifacts')
  const verified = new Set<string>()
  for (const file of files) {
    try {
      const bytes = await readFile(file.pdfPath)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const qa = JSON.parse(await readFile(file.qualityReportPath, 'utf8'))
      const document = [...expected].find(([_id, sourceHash]) => sourceHash && sourceHash === qa.documentId)?.[0]
      if (!document || verified.has(document) || qa.outputVersion !== hash || !review.outputHashes.includes(hash) || typeof qa.translationPolicy !== 'string' || !(qa.translationPolicy === policy || qa.translationPolicy.startsWith(`${policy}:`)) || qa.layoutVersion !== LAYOUT_VERSION || qa.layout?.status !== 'structure-passed') { reasons.push('stale-or-unmatched-layout-artifact'); continue }
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 })
      try { if ((await loading.promise).numPages < 1) throw new Error('Empty PDF') } finally { await loading.destroy() }
      verified.add(document)
    } catch { reasons.push('unreadable-layout-artifact') }
  }
  if (verified.size !== expected.size) reasons.push('incomplete-current-layout-review')
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)], verifiedDocuments: [...verified] }
}
