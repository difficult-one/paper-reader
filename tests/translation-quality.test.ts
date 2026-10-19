import { expect, it } from 'vitest'
import { faithfulNumbers, qualityParagraph } from '../src/main/translation-quality'

it('counts attached PDF footnote numbers equally beside Latin and Chinese words', () => {
  expect(qualityParagraph('All scholarly research objects2 benefit from these principles.', '所有学术研究对象2都受益于这些原则。')).toBe(true)
  expect(qualityParagraph('All research objects2 benefit.', '所有研究对象3都受益。')).toBe(false)
  expect(qualityParagraph('Use model2 and model3.', '使用模型2与模型3。')).toBe(true)
})
it('ends preserved links at Chinese parentheses without swallowing following text or numbers', () => {
  expect(qualityParagraph('See (https://example.org/a?q=2) and results3.', '见（https://example.org/a?q=2），结果3。')).toBe(true)
})

it.each([
  ['p < 0.05; -3.2e-4 A; 95% CI [1.2, 1.8].', 'p＜0.05；−3.2×10^-4 A；95 % CI [1.2，1.8]。'],
  ['There were 1,200 samples and 3.00 V.', '样本为 1 200 个，电压 3 V。'],
  ['Fig. 2: 1.2–1.8 ms.', '图 2：1.2 至 1.8 ms。'],
  ["<style id='123'>p = 0.05</style> {v45}", "{v45}<style id='123'>p＝0.050</style>"],
  ['See https://doi.org/10.1234/test.2025 and 10 mg.', '见 https://doi.org/10.1234/test.2025 和 10 mg。'],
  ['1.23456789123456789 V', '1.23456789123456789 V']
])('合法数值表示与顺序变化可接受：%s', (source, output) => expect(qualityParagraph(source, output)).toBe(true))

it.each([
  ['p < 0.05', 'p > 0.05'], ['p = 0.05', 'p = 0.5'], ['-3.2e-4 A', '3.2e-4 A'],
  ['95% CI [1.2, 1.8]', '95% CI [1.2, 1.9]'], ['10% and 20 samples', '10 和 20 个样本'],
  ['1.23456789123456789 V', '1.23456789123456788 V'], ['10 mA', '10 A'],
  ['20 samples {v1}', '20 个样本'], ['20 samples', '20 个样本，另有 5 个'], ['1,200 samples', '1,201 个样本']
])('改变数值、比较或公式不会通过：%s', (source, output) => expect(qualityParagraph(source, output)).toBe(false))

it('数字相同仍不声称检查了语义', () => {
  expect(faithfulNumbers('The effect may not exceed 5%.', '该效应必定超过 5%。')).toBe(true)
})

it('保持置信区间端点顺序，兼容科学计数上标与中文单位', () => {
  expect(faithfulNumbers('95% CI [1.2, 1.8]', '95% CI [1.8, 1.2]')).toBe(false)
  expect(faithfulNumbers('-3.2e-4 A', '−3.2 × 10⁻⁴ A')).toBe(true)
  expect(faithfulNumbers('10 mA and 3 V', '10 毫安和 3 伏')).toBe(true)
})
it('英文日期转换中文日期保持年月日，不能交换月日或改变月份', () => {
  expect(faithfulNumbers('Received: 10 December 2015', '收稿日期：2015年12月10日')).toBe(true)
  expect(faithfulNumbers('December 10, 2015', '2015年12月10日')).toBe(true)
  expect(faithfulNumbers('10 December 2015', '2015年10月12日')).toBe(false)
  expect(faithfulNumbers('10 December 2015', '2015年11月10日')).toBe(false)
})

it.each([
  ['[12] Smith. doi:10.1234/AbC. https://example.org/paper?q=2', '[12] Smith。doi:10.1234/AbC。https://example.org/paper?q=2'],
  ['See [1, 3–5]. DOI: https://doi.org/10.1234/abc.', '见 [1,3-5]。DOI：10.1234/abc。']
])('accepts typographic equivalents of bibliography identifiers: %s', (source, output) => {
  expect(qualityParagraph(source, output)).toBe(true)
})
it.each([
  ['[12] Smith. doi:10.1234/abc', '[12] Smith。doi:10.1234/xyz'],
  ['See https://example.org/AbC', '见 https://example.org/abc'],
  ['No source link.', '没有链接。https://example.org/invented'],
  ['See [1, 3].', '见 [1, 4]。'],
  ['1. Smith. 2. Jones.', '2. Smith. 1. Jones.'],
  ['Smith [CrossRef]', 'Smith']
])('rejects missing, invented, or rebound citation identifiers: %s', (source, output) => {
  expect(qualityParagraph(source, output)).toBe(false)
})
