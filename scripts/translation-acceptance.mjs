import { build } from 'vite'
import { builtinModules } from 'node:module'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const directory = resolve(option('--output') ?? 'output/translation-skill-evals/acceptance-current')
const live = args.includes('--live')
const assessing = args.includes('--assess')
if (live && assessing) throw new Error('Choose collection or assessment, not both')
if (live && (!option('--settings') || !option('--prices') || !option('--budget-usd') || !process.env.PAPER_READER_EXPERIMENT_API_KEY)) throw new Error('Live collection requires --settings, --prices, --budget-usd and PAPER_READER_EXPERIMENT_API_KEY')
await mkdir(directory, { recursive: true })
const runner = join(directory, 'runner')
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve('src/main/translation-acceptance-runner.ts'), outDir: runner, emptyOutDir: false, rollupOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: { entryFileNames: 'acceptance.mjs' } } } })
const api = await import(pathToFileURL(join(runner, 'acceptance.mjs')).href)
const corpus = resolve('skills/research-bilingual-translation/evals')
const cases = (await readFile(join(corpus, 'paper-cases.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line))
const baseline = await readFile(join(corpus, 'baseline-body-system.txt'), 'utf8')
const controller = new AbortController(); process.once('SIGINT', () => controller.abort())
let result
if (assessing) {
  if (!option('--decisions')) throw new Error('--assess requires a completed --decisions JSON file')
  const load = async name => JSON.parse(await readFile(join(directory, name), 'utf8'))
  const decisions = JSON.parse(await readFile(resolve(option('--decisions')), 'utf8'))
  const layout = option('--layout-review') ? JSON.parse(await readFile(resolve(option('--layout-review')), 'utf8')) : null
  const outputs = await load('outputs.json')
  const policies = await load('policies.json')
  if (JSON.stringify(await load('source-cases.json')) !== JSON.stringify(cases)) throw new Error('Frozen experiment corpus differs from the current corpus; do not relabel old reviews')
  const expectedPolicies = { baseline: `archived-body-${createHash('sha256').update(baseline.trim()).digest('hex')}`, candidate: api.currentAcceptancePolicy }
  if (policies.baseline !== expectedPolicies.baseline || policies.candidate !== expectedPolicies.candidate) throw new Error('Experiment policies differ from the current release policies; collect and review the intended versions')
  const artifacts = option('--layout-artifacts') ? JSON.parse(await readFile(resolve(option('--layout-artifacts')), 'utf8')) : []
  const layoutCheck = await api.verifyHumanLayoutReview(cases, expectedPolicies.candidate, artifacts, layout)
  result = { ...api.assessTranslationAcceptance(cases, outputs, await load('blind-key.json'), decisions, { policies: expectedPolicies, costs: await api.verifyCollectionCosts(directory), layout: layoutCheck.passed ? 'passed' : 'pending' }), layoutEvidence: layoutCheck }
  await writeFile(join(directory, 'acceptance-status.json'), JSON.stringify(result, null, 2) + '\n')
} else if (live) result = await api.collectTranslationAcceptance(cases, baseline, directory, { settings: JSON.parse(await readFile(resolve(option('--settings')), 'utf8')), prices: JSON.parse(await readFile(resolve(option('--prices')), 'utf8')), apiKey: process.env.PAPER_READER_EXPERIMENT_API_KEY, budgetUsd: Number(option('--budget-usd')), maxInputTokens: Number(option('--max-input-tokens') ?? 131072), maxOutputTokens: Number(option('--max-output-tokens') ?? 65536), signal: controller.signal })
else result = await api.prepareTranslationAcceptance(cases, baseline, directory)
if (!assessing) await writeFile(join(directory, 'preparation.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ mode: assessing ? 'assess' : live ? 'live' : 'prepared-no-network', directory, ...result }, null, 2))
if (assessing && !result.ready || live && result.state.status !== 'collected') process.exitCode = 1
