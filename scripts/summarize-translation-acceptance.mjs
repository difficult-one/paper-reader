// Offline reconciliation: preserve original reports and never invent a model/human review.
import { build } from 'vite'
import { builtinModules } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const directory = resolve(process.argv[2] ?? 'output/translation-skill-evals/live-deepseek-20261018-final')
const load = async name => JSON.parse(await readFile(join(directory, name), 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')
const runner = join(directory, 'offline-report')
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve('src/main/translation-quality.ts'), outDir: runner, emptyOutDir: false, rollupOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: { entryFileNames: 'quality.mjs' } } } })
const { qualityParagraph } = await import(pathToFileURL(join(runner, 'quality.mjs')).href)
const cases = await load('source-cases.json'); const runs = await load('outputs.json'); const policies = await load('policies.json'); const plan = await load('request-plan.json')
if (new Set(runs.map(row => JSON.stringify([row.caseId, row.arm]))).size !== runs.length) throw new Error('Duplicate run')
const paragraphs = []; const issues = []
for (const sample of cases) {
  if (sha(sample.source) !== sample.sourceHash) throw new Error('Stale frozen source')
  const batch = plan.find(batch => batch.caseIds.includes(sample.id))
  const raw = await load(`quality/${batch.id}/translation-quality-report.json`).catch(() => null)
  for (const arm of ['baseline', 'candidate']) {
    const run = runs.find(row => row.caseId === sample.id && row.arm === arm)
    if (!run || run.sourceHash !== sample.sourceHash || run.policy !== policies[arm]) throw new Error('Unmatched run source/policy')
    const passed = run.status === 'completed' && qualityParagraph(sample.source, run.output)
    const reviewHash = sha(JSON.stringify(run.output))
    const matches = arm === 'candidate' && passed ? raw?.paragraphs.filter(row => row.source === sample.source && row.output === run.output && row.translationHash === reviewHash) ?? [] : []
    const review = matches.length === 1 ? matches[0] : null
    const actualModelReview = review?.reviewMethod === 'model' && ['model-passed', 'unresolved'].includes(review.semanticStatus)
    paragraphs.push({ caseId: sample.id, arm, documentId: sample.documentId, page: sample.page, rect: sample.rect, sourceHash: sample.sourceHash, outputHash: sha(run.output), collectionStatus: run.status, structuralStatus: passed ? 'passed' : 'failed', semanticStatus: review?.semanticStatus ?? 'pending', actualModelReview, humanReview: 'pending', locationSource: 'frozen-paper-corpus', reportReconciliation: passed && !review && arm === 'candidate' ? 'No matching successful-output review; retained semantic pending. Older partial-batch report may have classified successful siblings as missing.' : null })
    if (actualModelReview) for (const issue of raw.issues.filter(issue => issue.paragraphId === review.paragraphId && issue.translationHash === reviewHash)) {
      if (!sample.source.includes(issue.sourceQuote) || !run.output.includes(issue.translationQuote)) throw new Error('Unmatched semantic evidence')
      issues.push({ ...issue, caseId: sample.id, corpusDocumentId: sample.documentId, corpusPage: sample.page, corpusRect: sample.rect, humanReview: 'pending' })
    }
  }
}
const summary = Object.fromEntries(['baseline', 'candidate'].map(arm => { const rows = paragraphs.filter(row => row.arm === arm); return [arm, { expected: rows.length, completed: rows.filter(row => row.collectionStatus === 'completed').length, failed: rows.filter(row => row.collectionStatus === 'failed').length, missing: rows.filter(row => row.collectionStatus === 'missing').length, structuralPassed: rows.filter(row => row.structuralStatus === 'passed').length, actuallyModelReviewed: rows.filter(row => row.actualModelReview).length, humanReviewed: 0 }] }))
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), method: 'offline-evidence-reconciliation', madeNetworkCalls: false, releaseReady: false, summary, paragraphs, issues, limitations: ['Original execution reports are preserved. This reconciles deterministic states against actual saved successful outputs.', 'Missing semantic coverage remains pending; no review is performed by this script.', 'Rejected paragraph text unavailable in final gateway replies remains failed and cannot be counted as a successful translation.', 'All human review remains pending.'] }
await writeFile(join(directory, 'reconciled-quality-summary.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ summary, modelReportedIssues: issues.length, releaseReady: false }))
