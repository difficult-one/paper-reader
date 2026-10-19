import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { qualityParagraph } from '../src/main/translation-quality'
import { semanticRiskCategories } from '../src/main/translation-review'

const root = 'skills/research-bilingual-translation/evals'
const lines = async (name: string) => (await readFile(`${root}/${name}`, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))

it('executes frozen positive controls and blocks damaged numbers, identifiers and placeholders', async () => {
  const controls = await lines('cases.jsonl')
  for (const sample of controls) expect(qualityParagraph(sample.source, sample.acceptable), sample.id).toBe(true)
  const deterministic = ['strict-comparator', 'unicode-comparator', 'scientific-notation', 'confidence-interval', 'unit-change', 'identifier-protection', 'formula-style', 'real-fair-date', 'unchanged-numbers-url-change']
  for (const id of deterministic) {
    const sample = controls.find(sample => sample.id === id)
    expect(qualityParagraph(sample.source, sample.reject), id).toBe(false)
  }
  for (const id of ['swapped-groups', 'necessary-only-if', 'negation-significance', 'bounded-convergence', 'causation']) {
    const sample = controls.find(sample => sample.id === id)
    expect(semanticRiskCategories(sample.source).length, id).toBeGreaterThan(0)
  }
})
it('keeps the real corpus attributable and unreviewed instead of claiming semantic validation', async () => {
  const samples = await lines('paper-cases.jsonl')
  const manifest = JSON.parse(await readFile(`${root}/paper-corpus.json`, 'utf8'))
  expect(samples).toHaveLength(200)
  expect(new Set(samples.map(sample => sample.id)).size).toBe(200)
  expect(new Set(samples.map(sample => sample.documentId)).size).toBeGreaterThanOrEqual(10)
  expect(new Set(samples.map(sample => sample.discipline)).size).toBeGreaterThanOrEqual(3)
  for (const sample of samples) {
    const paper = manifest.papers.find((paper: any) => paper.id === sample.documentId)
    expect(sample.documentSha256).toBe(paper.sha256)
    expect(sample.sourceUrl).toBe(paper.url)
    expect(sample.page).toBeGreaterThan(0)
    expect(sample.page).toBeLessThanOrEqual(paper.pages)
    expect(sample.rect.every((number: number) => Number.isFinite(number) && number >= 0 && number <= 1)).toBe(true)
    expect(sample.reviewStatus).toBe('pending')
    expect(sample.constraints.semantic.length).toBeGreaterThan(0)
  }
})
