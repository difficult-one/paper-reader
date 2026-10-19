import type { ChatRequest } from './translation-gateway'

export type TranslationStrategy = 'baseline' | 'terminology' | 'adaptive'
export function configuredStrategy(value = process.env.PAPER_READER_TRANSLATION_STRATEGY): TranslationStrategy {
  if (!value || value === 'baseline') return 'baseline'
  if (value === 'terminology' || value === 'adaptive') return value
  throw new Error('PAPER_READER_TRANSLATION_STRATEGY 必须为 baseline、terminology 或 adaptive。')
}
export const strategyVersion = (strategy: TranslationStrategy) => strategy === 'baseline' ? '' : `:token-strategy-${strategy}-v1`
export function semanticRisks(source: string): string[] {
  const patterns = {
    negation: /\b(?:not|no|never|neither|without|except|unless|fail(?:s|ed)? to)\b/i,
    condition: /\b(?:if|only|provided|assuming|subject to|conditional|limited to)\b/i,
    statistics: /\b(?:significan\w*|confidence|p\s*[<=>]|correlat\w*|causal\w*|odds ratio)\b/i,
    formula: /\b(?:eq(?:uation)?\.?|formula|theorem)\s*\(?\d|\{\w+\}|[∑∫≤≥]/i,
    ambiguity: /\b(?:may refer|instead|ambiguous|distinct meaning|different (?:meaning|definition)|in this (?:chapter|section|context))\b/i
  }
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(source)).map(([name]) => name)
}
export function clearDefinitionTerms(body: ChatRequest): boolean {
  const user = body.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
  const start = user.lastIndexOf('Input Text:\n```\n')
  const end = user.lastIndexOf('\n```')
  if (start < 0 || end <= start) return false
  const source = user.slice(start + 'Input Text:\n```\n'.length, end)
  return source.length <= 2400 && semanticRisks(source).length === 0 && source.split(/\n\s*\n/).every(part => /\b(?:is defined as|means|denotes)\b/i.test(part))
}
