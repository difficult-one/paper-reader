import { ruleBundle } from './translation-policy'

export type Message = { role: string; content: string; [key: string]: unknown }
export function batchInputStart(text: string): number {
  const marker = '## Here is the input:'
  const line = text.lastIndexOf(`\n${marker}`)
  return line >= 0 ? line + 1 : text.startsWith(marker) ? 0 : -1
}

// Only JSON object keys are canonicalized. Arrays and text retain their order and values.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
const cleanRules = (text: string) => text.replace(/\n{3,}/g, '\n\n').trim()
const pair = (rules: string, input: string, task: 'body' | 'terminology' = 'body'): Message[] => [{ role: 'system', content: `${cleanRules(rules)}\n\n## Research translation quality\n${ruleBundle.core.trim()}\n\n## Research ${task} rules\n${ruleBundle[task].trim()}` }, { role: 'user', content: input }]

export function stableMessages(messages: Message[], separateTermRules = false): Message[] {
  if (messages.some(message => Object.keys(message).some(key => key !== 'role' && key !== 'content'))) return messages
  if (messages.length === 2 && messages[0].role === 'system' && messages[0].content === 'You are a professional,authentic machine translation engine.' && messages[1].role === 'user') {
    const text = messages[1].content
    const boundary = text.indexOf(' Input:\n\n')
    if (text.startsWith(';; Treat next line as plain text input and translate it into ') && boundary >= 0) {
      return pair(`${messages[0].content}\n\n${text.slice(0, boundary + ' Input:'.length)}`, text.slice(boundary + ' Input:\n\n'.length))
    }
  }
  if (messages.length !== 1 || messages[0].role !== 'user') return messages
  const text = messages[0].content
  // BabelDOC's single-paragraph fallback uses a separate, concrete template.
  if (text.startsWith('You are a professional ') && text.includes('\n## Rules\n')) {
    const marker = '\nNow translate the following text:\n'
    const inputIndex = text.lastIndexOf(marker)
    const outputIndex = text.indexOf('\n## Output\n')
    if (outputIndex < 0 || inputIndex <= outputIndex) return messages
    const variables = ['\n## Glossary\n', '\n## Context / Hints\n'].map(value => text.indexOf(value)).filter(index => index >= 0 && index < outputIndex)
    const boundary = Math.min(outputIndex, ...variables)
    const variableText = text.slice(boundary, outputIndex)
    const glossaryIndex = variableText.indexOf('\n## Glossary\n')
    const contextIndex = variableText.indexOf('\n## Context / Hints\n')
    const glossary = glossaryIndex >= 0 ? variableText.slice(glossaryIndex, contextIndex > glossaryIndex ? contextIndex : undefined).trim() : ''
    const context = contextIndex >= 0 ? variableText.slice(contextIndex, glossaryIndex > contextIndex ? glossaryIndex : undefined).trim() : ''
    return pair(`${text.slice(0, boundary)}\n${text.slice(outputIndex, inputIndex)}`, [context, glossary, text.slice(inputIndex).trim()].filter(Boolean).join('\n\n'))
  }
  if (text.startsWith('You are a professional ') && text.includes('\n## Structure Rules\n')) {
    const marker = '\n## Here is the input:'
    const inputIndex = text.indexOf(marker)
    if (inputIndex < 0) return messages
    let input: unknown
    try { input = JSON.parse(text.slice(inputIndex + marker.length).trim()) } catch { return messages }
    if (!Array.isArray(input) || input.some(item => !item || typeof item !== 'object' || !('id' in item) || typeof item.input !== 'string')) return messages
    const positions = ['\n## Contextual Hints for Better Translation', '\n## Glossary Tables'].map(marker => text.indexOf(marker)).filter(index => index >= 0 && index < inputIndex)
    const boundary = Math.min(inputIndex, ...positions)
    let rules = text.slice(0, boundary)
    const glossary = rules.match(/\n## Glossary\n[\s\S]*?(?=\n## Output Format)/)?.[0] ?? ''
    if (glossary) rules = rules.replace(glossary, '\n')
    const context = text.slice(boundary, inputIndex).trim()
    const tableIndex = context.indexOf('## Glossary Tables')
    const hints = tableIndex >= 0 ? context.slice(0, tableIndex).trim() : context
    const table = tableIndex >= 0 ? context.slice(tableIndex).trim() : ''
    // Document and section titles precede batch-specific glossary entries.
    return pair(rules, [hints, glossary.trim(), table, `## Here is the input:\n${canonicalJson(input)}`].filter(Boolean).join('\n\n'))
  }
  if (text.trimStart().startsWith('You are an expert multilingual terminologist.') && text.includes('\n### Extraction Rules\n') && text.includes('\n### Translation Rules\n')) {
    const inputIndex = text.indexOf('\nInput Text:\n```\n')
    const outputIndex = text.indexOf('\n### Output Format\n')
    if (inputIndex < 0 || outputIndex < 0 || outputIndex >= inputIndex) return messages
    const referenceIndex = text.indexOf('\nReference Glossaries (for consistency and quality):')
    const hasReference = referenceIndex >= 0 && referenceIndex < outputIndex
    const rules = hasReference ? text.slice(0, referenceIndex) + '\n' + text.slice(outputIndex, inputIndex) : text.slice(0, inputIndex)
    const reference = hasReference ? text.slice(referenceIndex, outputIndex).trim() : ''
    const input = [reference, text.slice(inputIndex).trim()].filter(Boolean).join('\n\n')
    return pair(rules, input, 'terminology')
  }
  return messages
}
