import { expect, it } from 'vitest'
import { stableMessages } from '../src/main/translation-prompts'
import { translationPolicyFingerprint, ruleBundle } from '../src/main/translation-policy'
import { describePrefix } from '../src/main/cache-diagnostics'
import { legacyPdfKey, LAYOUT_VERSION } from '../src/main/cache-versions'

const body = 'You are a professional zh translator.\n## Structure Rules\nKeep IDs.\n## Output Format\nReturn JSON.\n## Here is the input:\n[{"id":0,"input":"Evidence may vary."}]'
const terminology = 'You are an expert multilingual terminologist.\n### Extraction Rules\nExtract terms.\n### Translation Rules\nTranslate terms.\n### Output Format\nReturn [{"src":"","tgt":""}].\nInput Text:\n```\nEvidence\n```'
it('never revives the legacy PDF namespace after an independent layout upgrade', () => {
  const settings = { baseUrl: 'https://example.org/v1', apiKey: 'local-test', model: 'test', qps: 1 }
  const translation = 'research-cache-v1-bcf26326f1fddf6b1ea78f1fbec552d20119fc567da008383c74906065907dea'
  expect(legacyPdfKey('doc', settings, { translation, layout: LAYOUT_VERSION })).toBeNull()
  expect(legacyPdfKey('doc', settings, { translation, layout: '2.9.0-BabelDOC-0.6.3-research-layout-1' })).toMatch(/^[a-f0-9]{64}$/)
})
it('compiles the relevant task rules without dropping the shared trust boundary', () => {
  const a = stableMessages([{ role: 'user', content: body }])
  const b = stableMessages([{ role: 'user', content: terminology }])
  expect(a[0].content).toContain(ruleBundle.core.trim())
  expect(b[0].content).toContain(ruleBundle.core.trim())
  expect(a[0].content).toContain(ruleBundle.body.trim())
  expect(a[0].content).not.toContain(ruleBundle.terminology.trim())
  expect(b[0].content).toContain(ruleBundle.terminology.trim())
  expect(b[0].content).not.toContain(ruleBundle.body.trim())
  expect(a[1].content).toContain('Evidence may vary.')
})
it('invalidates translations for each compiled rule or contract change', () => {
  const old = translationPolicyFingerprint(ruleBundle)
  for (const key of ['core', 'body', 'terminology', 'template', 'routing', 'paragraphs'] as const) {
    expect(translationPolicyFingerprint({ ...ruleBundle, [key]: ruleBundle[key] + '\nchanged' })).not.toBe(old)
  }
  expect(translationPolicyFingerprint({ ...ruleBundle })).toBe(old)
})
it('recognizes the concrete PDF2ZH single fallback contract', () => {
  const messages = stableMessages([{ role: 'system', content: 'You are a professional,authentic machine translation engine.' }, { role: 'user', content: ';; Treat next line as plain text input and translate it into zh. Input:\n\n20 samples' }])
  expect(describePrefix({ messages }).type).toBe('single')
  expect(messages[1].content).toBe('20 samples')
})
it('classifies archived CRLF system templates as batches without mutating their payload', () => {
  const system = 'You are a professional zh translator.\r\n## Structure Rules\r\nKeep IDs.'
  expect(describePrefix({ messages: [{ role: 'system', content: system }, { role: 'user', content: '## Here is the input:\n[{"id":0,"input":"Evidence may vary."}]' }] }).type).toBe('batch')
})
