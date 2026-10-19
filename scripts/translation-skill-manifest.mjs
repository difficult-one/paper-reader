import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')
const ruleFiles = { core: 'references/translation-rules.txt', body: 'references/body-rules.txt', terminology: 'references/terminology-rules.txt' }
export async function translationSkillManifest(directory) {
  const rules = Object.fromEntries(await Promise.all(Object.entries(ruleFiles).map(async ([key, path]) => [key, (await readFile(join(directory, path), 'utf8')).trim()])))
  const contract = JSON.parse(await readFile(join(directory, 'references/policy-contract.json'), 'utf8'))
  const fingerprint = sha(JSON.stringify(Object.entries({ ...rules, ...contract }).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.trim()])))
  const files = [...Object.values(ruleFiles), 'references/policy-contract.json', 'references/review-rules.md', 'references/glossary-schema.md', 'references/quality-report-schema.md', 'references/review-examples.md', 'references/sources.md', 'SKILL.md', 'evals/cases.jsonl', 'evals/paper-cases.jsonl', 'evals/paper-corpus.json', 'evals/baseline-body-system.txt', 'evals/rubric.md']
  const fingerprints = Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(join(directory, path)))])))
  return { schemaVersion: 1, maintenanceSource: 'paper-reader/skills/research-bilingual-translation', translationPolicy: `research-cache-v2-${fingerprint}`, contract, files: fingerprints }
}
export async function verifyTranslationSkill(directory) {
  const expected = await translationSkillManifest(directory)
  const actual = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('翻译 skill 来源或规则指纹不匹配，请先更新 provenance.json 后重新构建。')
  return expected
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[3] ?? 'skills/research-bilingual-translation')
  if (process.argv[2] === 'write') {
    await writeFile(join(directory, 'provenance.json'), JSON.stringify(await translationSkillManifest(directory), null, 2) + '\n')
  } else await verifyTranslationSkill(directory)
  console.log('翻译 skill 规则与来源指纹已核验。')
}
