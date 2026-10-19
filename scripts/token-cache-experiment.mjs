import { build } from 'vite'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { builtinModules } from 'node:module'

const args = process.argv.slice(2)
const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined }
const live = args.includes('--live')
if (live && (!value('--manifest') || !value('--budget-usd') || !process.env.PAPER_READER_EXPERIMENT_API_KEY)) throw new Error('--live 需要 --manifest、--budget-usd 和 PAPER_READER_EXPERIMENT_API_KEY。')
const directory = resolve(value('--output') ?? join('output', `token-cache-experiment-${Date.now()}`))
const bundle = join(directory, 'runner')
await mkdir(bundle, { recursive: true })
await build({ configFile: false, logLevel: 'error', build: { ssr: resolve('src/main/token-cache-runner.ts'), outDir: bundle, emptyOutDir: false, rollupOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)], output: { entryFileNames: 'experiment.mjs' } } } })
const { runTokenExperiment, offlineFixture } = await import(pathToFileURL(join(bundle, 'experiment.mjs')).href)
const manifest = value('--manifest') ? JSON.parse(await readFile(resolve(value('--manifest')), 'utf8')) : offlineFixture()
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
console.log(JSON.stringify(await runTokenExperiment(manifest, { directory, live, budgetUsd: value('--budget-usd') ? Number(value('--budget-usd')) : undefined, apiKey: live ? process.env.PAPER_READER_EXPERIMENT_API_KEY : undefined, signal: controller.signal }), null, 2))
