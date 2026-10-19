import { createHash } from 'node:crypto'
import { ruleBundle, translationPolicyFingerprint } from './translation-policy'
import { cacheKey } from '../shared/core'
import type { ServiceSettings } from '../shared/types'
import { configuredStrategy, strategyVersion, type TranslationStrategy } from './translation-strategy'

export interface CacheVersions { translation: string; layout: string; strategy?: TranslationStrategy }
export const TRANSLATION_POLICY_VERSION = `research-cache-v2-${translationPolicyFingerprint()}`
export const LAYOUT_VERSION = '2.9.0-BabelDOC-0.6.3-research-layout-2'
export const EXTRACTION_VERSION = ruleBundle.paragraphs
export const CACHE_VERSIONS: CacheVersions = { translation: TRANSLATION_POLICY_VERSION, layout: LAYOUT_VERSION, strategy: configuredStrategy() }
export function pdfCacheKey(document: string, settings: ServiceSettings, versions: CacheVersions): string {
  return createHash('sha256').update(cacheKey(document, settings, JSON.stringify([versions.translation + (settings.translationMode === 'economy' ? ':economy-quality-v1' : '') + strategyVersion(versions.strategy ?? 'baseline'), versions.layout]))).digest('hex')
}
// The former research-layout-1 release used these exact rules. Retain its PDF/annotation key
// only while both policies remain compatible. Never write new data into its namespace.
export function legacyPdfKey(document: string, settings: ServiceSettings, versions: CacheVersions): string | null {
  const legacyLayout = '2.9.0-BabelDOC-0.6.3-research-layout-1'
  if (versions.strategy && versions.strategy !== 'baseline') return null
  if (versions.translation !== 'research-cache-v1-bcf26326f1fddf6b1ea78f1fbec552d20119fc567da008383c74906065907dea' || versions.layout !== legacyLayout) return null
  return createHash('sha256').update(cacheKey(document, settings, legacyLayout)).digest('hex')
}
