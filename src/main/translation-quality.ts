import { canonicalJson } from './translation-prompts'
import { validParagraph } from './paragraph-cache'
const numberPattern = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?'
const linkPattern = /https?:\/\/[^\s<>，。；（）「」『』【】《》“”‘’]+|\b10\.\d{4,9}\/[^\s<>，。；（）「」『』【】《》“”‘’]+/gi
const units: Record<string, string> = { 毫安: 'mA', 微安: 'μA', 安培: 'A', 安: 'A', 毫伏: 'mV', 伏特: 'V', 伏: 'V', 毫瓦: 'mW', 千瓦: 'kW', 瓦特: 'W', 瓦: 'W', 千赫兹: 'kHz', 兆赫兹: 'MHz', 赫兹: 'Hz', 毫秒: 'ms', 微秒: 'μs', 纳秒: 'ns', 秒: 's', 千米: 'km', 厘米: 'cm', 毫米: 'mm', 微米: 'μm', 纳米: 'nm', 米: 'm', 千克: 'kg', 毫克: 'mg', 微克: 'μg', 克: 'g', 毫升: 'mL', 升: 'L', 开尔文: 'K', 帕斯卡: 'Pa', 焦耳: 'J', 摩尔: 'mol' }
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const dateToken = (year: string, month: string | number, day: string) => ` #date:${Number(year)}/${Number(month)}/${Number(day)}# `

function plain(text: string): string {
  return text.replace(linkPattern, '')
    .replace(/\{[\w]+\}|\[\[[^\]\r\n]+\]\]|%%[^%\r\n]+%%|<\/?[a-zA-Z][^>\r\n]*>/g, '')
    .replace(/[−﹣－]/g, '-').replace(/[＋]/g, '+').replace(/[＜]/g, '<').replace(/[＞]/g, '>').replace(/[＝]/g, '=').replace(/[％]/g, '%')
    .replace(/10([⁺⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g, (_match, power: string) => `10^${[...power].map(c => '⁺⁻⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)).map(i => '+-0123456789'[i]).join('')}`)
    .replace(/(\d+(?:\.\d+)?)\s*[×x]\s*10\s*\^\s*([+-]?\d+)/g, '$1e$2')
    .replace(/\b\d{1,3}(?:[,\u2009\u202f ]\d{3})+(?:\.\d+)?\b/g, value => value.replace(/[,\u2009\u202f ]/g, ''))
    .replace(/(?<=\d)\s*[-–—]\s*(?=\d)/g, ' .. ')
    .replace(new RegExp(`(?<=\\d)\\s*(${Object.keys(units).join('|')})`, 'g'), (_match, unit: string) => ` ${units[unit]}`)
    .replace(new RegExp(`\\b(\\d{1,2})\\s+(${months.join('|')})\\s+(\\d{4})\\b`, 'gi'), (_m, day: string, month: string, year: string) => dateToken(year, months.findIndex(m => m.toLowerCase() === month.toLowerCase()) + 1, day))
    .replace(new RegExp(`\\b(${months.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'), (_m, month: string, day: string, year: string) => dateToken(year, months.findIndex(m => m.toLowerCase() === month.toLowerCase()) + 1, day))
    .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, (_m, year: string, month: string, day: string) => dateToken(year, month, day))
}
function exactNumber(value: string): string {
  const match = value.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)!
  let digits = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '')
  let power = Number(match[4] ?? 0) - (match[3]?.length ?? 0)
  if (!digits) return '0'
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); power++ }
  return `${match[1] === '-' ? '-' : ''}${digits}e${power}`
}
function numericClaims(text: string): string[] {
  // Conservative literal checks. These do not certify semantics, negation or unit conversions.
  const dates: string[] = []
  const cleaned = plain(text).replace(/#date:(\d+)\/(\d+)\/(\d+)#/g, (_m, year, month, day) => { dates.push(canonicalJson(['date', year, month, day])); return '' })
  const pattern = /([<>]=?|[≤≥≈=])?\s*(?<![\d.])([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(\s*(?:%|(?:[munpμµkMGT]?)(?:A|V|W|Hz|Pa|J|K|m|s|g|L|mol)\b))?/gi
  const claims = [...cleaned.matchAll(pattern)].map(match => canonicalJson([(match[1] ?? '').replace('<=', '≤').replace('>=', '≥'), exactNumber(match[2]), (match[3] ?? '').replace(/\s+/g, '').replace('µ', 'μ')]))
  const intervals = new RegExp(`[\\[(]\\s*(${numberPattern})\\s*[,，]\\s*(${numberPattern})\\s*[\\])]`, 'gi')
  for (const match of cleaned.matchAll(intervals)) claims.push(canonicalJson(['interval', exactNumber(match[1]), exactNumber(match[2])]))
  return [...claims, ...dates].sort()
}
export function faithfulNumbers(source: string, output: string): boolean { return canonicalJson(numericClaims(source)) === canonicalJson(numericClaims(output)) }

function identifiers(text: string): string[] {
  const trim = (value: string) => value.replace(/[.,;:。，；：]+$/g, '').replace(/\)+$/g, suffix => (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0) ? '' : suffix)
  const links = (text.match(linkPattern) ?? []).map(value => trim(value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')))
  const citations = (text.match(/\[\s*\d+(?:\s*[,，;；–—-]\s*\d+)*\s*\]/g) ?? []).map(value => value.replace(/\s/g, '').replace(/[–—]/g, '-').replace(/，/g, ',').replace(/；/g, ';'))
  const markers = text.match(/\[(?:CrossRef|PubMed|PMC)\]/g) ?? []
  const numbering = [...text.matchAll(/(?:^|\n|(?<=[.!?。])\s+)(\d+)\.\s+(?=[A-Z\u4e00-\u9fff])/g)].map(match => match[1])
  return [...links.sort(), ...citations.sort(), ...markers.sort(), canonicalJson(numbering)]
}
export function faithfulIdentifiers(source: string, output: string): boolean { return canonicalJson(identifiers(source)) === canonicalJson(identifiers(output)) }
// Deterministic checks cannot establish semantic fidelity.
export function qualityParagraph(source: string, output: unknown): output is string { return validParagraph(source, output) && faithfulNumbers(source, output) && faithfulIdentifiers(source, output) }
