import { afterEach, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyHumanLayoutReview } from '../src/main/translation-layout-review'
import { LAYOUT_VERSION } from '../src/main/cache-versions'
const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
it('requires actual current PDF bytes, matching QA source/policy, and human-reviewed identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'layout-human-')); directories.push(directory)
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica); doc.addPage().drawText('Current PDF output.', { font })
  const bytes = await doc.save(); const pdfPath = join(directory, 'output.pdf'); await writeFile(pdfPath, bytes)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const qualityReportPath = join(directory, 'quality.json')
  const sourceHash = 'a'.repeat(64)
  const qa = { documentId: sourceHash, translationPolicy: 'current-policy:extraction-v1', layoutVersion: LAYOUT_VERSION, outputVersion: digest, layout: { status: 'structure-passed' } }
  await writeFile(qualityReportPath, JSON.stringify(qa))
  const cases = [{ id: 'p1', documentId: 'paper', documentSha256: sourceHash }]
  const review = { method: 'human', status: 'passed', reviewer: 'human-reviewer', reviewedAt: '2026-10-18', outputHashes: [digest] }
  const files = [{ pdfPath, qualityReportPath }]
  expect((await verifyHumanLayoutReview(cases, 'current-policy', files, review)).passed).toBe(true)
  expect((await verifyHumanLayoutReview(cases, 'current-policy', [], { ...review, outputHashes: ['f'.repeat(64)] })).passed).toBe(false)
  await writeFile(qualityReportPath, JSON.stringify({ ...qa, layoutVersion: 'older-layout' }))
  expect((await verifyHumanLayoutReview(cases, 'current-policy', files, review)).passed).toBe(false)
  await writeFile(qualityReportPath, JSON.stringify({ ...qa, translationPolicy: 'old-policy' }))
  expect((await verifyHumanLayoutReview(cases, 'current-policy', files, review)).passed).toBe(false)
  await writeFile(qualityReportPath, JSON.stringify({ ...qa, documentId: 'b'.repeat(64) }))
  expect((await verifyHumanLayoutReview(cases, 'current-policy', files, review)).passed).toBe(false)
  await writeFile(qualityReportPath, JSON.stringify(qa)); await writeFile(pdfPath, 'changed bytes')
  expect((await verifyHumanLayoutReview(cases, 'current-policy', files, review)).passed).toBe(false)
})
