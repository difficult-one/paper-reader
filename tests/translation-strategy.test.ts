import { expect, it } from 'vitest'
import { prepareTranslationRequest } from '../src/main/translation-gateway'
import { semanticRisks, strategyVersion } from '../src/main/translation-strategy'

const settings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'test', qps: 2, translationMode: 'economy' as const }
const terms = (source: string) => ({ messages: [{ role: 'user', content: `You are an expert multilingual terminologist.\n### Extraction Rules\nKeep nouns.\n### Translation Rules\nPreserve definitions and ambiguity.\n### Output Format\nJSON src/tgt.\nInput Text:\n\x60\x60\x60\n${source}\n\x60\x60\x60` }] })
it('仅 adaptive 在官方已知模型的清晰定义术语使用非思考，保留 schema 和术语规则', () => {
  const request = prepareTranslationRequest(terms('Rotor flux is defined as the magnetic flux of the rotor.'), settings, 'adaptive')
  expect(request.thinking).toEqual({ type: 'disabled' }); expect(request.reasoning_effort).toBeUndefined()
  expect(request.messages[0].content).toContain('Preserve definitions and ambiguity.')
  expect(request.messages[0].content).toContain('JSON src/tgt.')
  expect(request.messages[0].content).not.toContain('Research body rules')
  expect(prepareTranslationRequest(terms('Rotor flux is defined as flux.'), settings).reasoning_effort).toBe('low')
  expect(prepareTranslationRequest(terms('Flux may refer to different quantities.'), settings, 'adaptive').thinking).toEqual({ type: 'enabled' })
  expect(prepareTranslationRequest(terms('Flux is defined as density.'), { ...settings, model: 'unknown-model' }, 'adaptive').thinking).toEqual({ type: 'enabled' })
  expect(prepareTranslationRequest(terms('Flux is defined as density.'), { ...settings, baseUrl: 'https://example.com/v1' }, 'adaptive').thinking).toBeUndefined()
  expect(strategyVersion('baseline')).toBe(''); expect(strategyVersion('adaptive')).not.toBe('')
})
it('识别否定、条件、统计结论、公式关联和定义歧义，并保留普通段落通路', () => {
  for (const source of ['It did not increase.', 'Only if the load is stable.', 'p < 0.05 is significant.', 'Using Eq. (3), {v1} follows.', 'Here flux instead refers to density.']) expect(semanticRisks(source).length).toBeGreaterThan(0)
  expect(semanticRisks('The rotor rotates smoothly.')).toEqual([])
})
