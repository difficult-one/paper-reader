// Records the agent's actual visual observations of these immutable local runs.
// It does not inspect future outputs or create a human approval.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const root = resolve('output/translation-skill-evals')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileRecord = async path => ({ path: resolve(path), sha256: sha(await readFile(path)) })
const current = []
for (const [id, run, pages] of [['attention', 'attention-1792300193023', [2, 3, 5, 11]], ['resnet', 'resnet-1792300289684', [1, 3, 5, 9]]]) {
  const directory = join(root, 'layout-current', run)
  const qualityReportPath = join(directory, 'translation-quality-report.json')
  const qa = JSON.parse(await readFile(qualityReportPath, 'utf8'))
  current.push({ id, output: await fileRecord(join(directory, `${id}.no_watermark.zh.mono.pdf`)), quality: await fileRecord(qualityReportPath), translationPolicy: qa.translationPolicy, layoutVersion: qa.layoutVersion, structuralSummary: qa.summary, automatedLayoutStatus: qa.layout.status, pages: await Promise.all(pages.map(async page => ({ page, preview: await fileRecord(join(root, 'layout-current', `${id}-v4-p${page}.png`)) }))), service: 'local deterministic word substitutions, otherwise unchanged English', semanticQuality: 'not-measured', paidCalls: 0 })
}
const historical = []
for (const [id, run, pages, imagePrefix] of [['umap-A', 'umap-1-A', [1, 2], 'umap-live-A'], ['umap-B', 'umap-2-B', [1, 2], 'umap-live-B'], ['fair-A', 'fair-2-A', [1, 3, 5, 8, 9], 'fair-A'], ['fair-B', 'fair-1-B', [1, 3, 5, 8, 9], 'fair-B']]) {
  const name = id.split('-')[0]
  historical.push({ id, output: await fileRecord(resolve('output/deepseek-real-ab-20261017/runs', run, 'translated', `${name}.no_watermark.zh.mono.pdf`)), pages: await Promise.all(pages.map(async page => ({ page, preview: await fileRecord(join(root, 'acceptance', `${imagePrefix}-p${page}.png`)) }))), scope: 'Archived real-service outputs; historical policies only, not current candidate evidence' })
}
const report = {
  schemaVersion: 1, reviewedOn: '2026-10-18', method: 'agent-visual', reviewer: 'Codex assistant in this chat', humanReview: 'pending', releaseReady: false,
  current, historical,
  observations: [
    { scope: 'attention current p3/p5', result: 'Formula glyphs, diagram and caption remain visible; no evident clipping or diagram overlap in these rendered previews.' },
    { scope: 'attention current p11', result: 'References [5]–[24] now begin separate paragraphs, including the Łukasz author entries. The former page-wide merged paragraph was reproduced and fixed by Unicode marker recognition.', before: await fileRecord(join(root, 'layout-current', 'attention-p11.png')), after: await fileRecord(join(root, 'layout-current', 'attention-v4-p11.png')) },
    { scope: 'resnet current p1/p3/p5/p9', result: 'Two columns, equations, charts, tables, footnotes and bibliography remain visible. No evident new clipping or overlap in these previews.' },
    { scope: 'current local fixtures', result: 'English words and some headings/reference labels remain adjacent without expected spaces. This local word-substitution service does not evaluate complete Chinese translation or establish acceptable typography. Retain this limitation for real-service and human checks.' },
    { scope: 'historical UMAP A/B p1/p2', result: 'Figures and references are visible. Sidebar date and author/affiliation spacing are crowded; these are historical observations, not a current layout comparison.' },
    { scope: 'historical FAIR A/B p1/p3/p5/p8/p9', result: 'Columns, figures, references and author information were inspected. Crowded reference/author spacing remains. A PyMuPDF preview of FAIR B p8 appeared to omit part of an author list, but independent Poppler rendering shows the text; no confirmed omission is recorded.', independentRendererEvidence: [await fileRecord(join(root, 'acceptance', 'fair-B-p8-poppler.png')), await fileRecord(join(root, 'acceptance', 'fair-A-p8-poppler.png'))] }
  ],
  exclusions: ['The two UMAP PDFs in output/fidelity-economy-validation/engine-* are local mocks and are excluded from real translation quality evidence.'],
  limitations: ['22 sampled rendered pages, not a complete PDF audit.', 'Agent observations cannot be counted as human review.', 'Current fixtures verify engine/report/layout plumbing; no semantic error rate or release-quality improvement is claimed.']
}
await writeFile(join(root, 'acceptance', 'visual-review.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ currentDocuments: current.length, currentPages: 8, historicalDocuments: historical.length, historicalPages: 14, humanReview: report.humanReview, releaseReady: false }))
