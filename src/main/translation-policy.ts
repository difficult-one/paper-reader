import { createHash } from 'node:crypto'
import core from '../../skills/research-bilingual-translation/references/translation-rules.txt?raw'
import body from '../../skills/research-bilingual-translation/references/body-rules.txt?raw'
import terminology from '../../skills/research-bilingual-translation/references/terminology-rules.txt?raw'
import contract from '../../skills/research-bilingual-translation/references/policy-contract.json'

export const ruleBundle = { core, body, terminology, ...contract }
export function translationPolicyFingerprint(rules = ruleBundle): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.trim()]))).digest('hex')
}
