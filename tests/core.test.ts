import { describe, expect, it } from 'vitest'
import { cacheKey, validateSettings, normalizeBaseUrl, sanitizeLog, parseProgress, positionFromScroll, scrollFromPosition, serverCacheHitRate } from '../src/shared/core'

it('服务端命中率按可计算 H/M 加权，无分母和旧版统计均不显示伪比例', () => {
  expect(serverCacheHitRate({ samples: 2, hitTokens: 160, missTokens: 140 })).toBeCloseTo(160 / 300)
  expect(serverCacheHitRate({ samples: 0, hitTokens: 0, missTokens: 0 })).toBeNull()
  expect(serverCacheHitRate(undefined)).toBeNull()
})

describe('翻译设置与缓存', () => {
  const config = { baseUrl: 'https://api.example.com/v1', model: 'model-a', apiKey: 'secret', qps: 2 }
  it('规范化兼容接口地址，但不重复追加 v1', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
    expect(normalizeBaseUrl('https://api.example.com/custom/v2')).toBe('https://api.example.com/custom/v2')
  })
  it('拒绝不安全的远程接口、空模型和无效并发参数', () => {
    expect(() => validateSettings({ ...config, baseUrl: 'http://remote.example.com' })).toThrow()
    expect(() => validateSettings({ ...config, model: '' })).toThrow()
    expect(() => validateSettings({ ...config, qps: 0 })).toThrow()
    expect(() => validateSettings({ ...config, baseUrl: 'http://127.0.0.1:8899/v1' })).not.toThrow()
  })
  it('更换模型、文件或引擎版本使缓存失效，密钥轮换不影响缓存', () => {
    const first = cacheKey('file-a', config, '2.9.0')
    expect(cacheKey('file-a', { ...config, apiKey: 'new-secret' }, '2.9.0')).toBe(first)
    expect(cacheKey('file-a', { ...config, model: 'model-b' }, '2.9.0')).not.toBe(first)
    expect(cacheKey('file-b', config, '2.9.0')).not.toBe(first)
    expect(cacheKey('file-a', config, '2.10.0')).not.toBe(first)
    expect(cacheKey('file-a', { ...config, reasoningEffort: 'high' }, '2.9.0')).toBe(first)
    expect(cacheKey('file-a', { ...config, reasoningEffort: 'low' }, '2.9.0')).not.toBe(first)
    expect(cacheKey('file-a', { ...config, reasoningEffort: 'max' }, '2.9.0')).not.toBe(first)
  })
  it('进度日志不会泄露密钥或终端转义字符', () => {
    expect(sanitizeLog('\x1b[31mAuthorization: Bearer sk-private\x1b[0m custom-secret', ['custom-secret'])).not.toContain('custom-secret')
    expect(sanitizeLog('api_key="sk-private"', [])).not.toContain('sk-private')
    expect(sanitizeLog('abc\x1b[31mdef', [])).toBe('abcdef')
  })
  it('只报告引擎实际提供的百分比，不凭日志行数推算进度', () => {
    expect(parseProgress('Translate Paragraphs 42%')).toEqual({ stage: '正在翻译正文', percent: 42 })
    expect(parseProgress('Warmup babeldoc assets...').percent).toBeNull()
  })
})

describe('阅读位置映射', () => {
  const pages = [{ top: 16, height: 800 }, { top: 832, height: 1200 }]
  it('按页和页内比例映射，而非整份文档的滚动百分比', () => {
    expect(positionFromScroll(1132, pages)).toEqual({ page: 2, fraction: 0.25 })
    expect(scrollFromPosition({ page: 2, fraction: 0.25 }, [{ top: 16, height: 400 }, { top: 432, height: 600 }])).toBe(582)
  })
  it('限制越界和空文档输入', () => {
    expect(positionFromScroll(-40, pages)).toEqual({ page: 1, fraction: 0 })
    expect(scrollFromPosition({ page: 99, fraction: 4 }, pages)).toBe(2032)
    expect(positionFromScroll(10, [])).toEqual({ page: 1, fraction: 0 })
  })
  it('长文档定位只读取对数数量的页几何数据', () => {
    let reads = 0
    const pages = Array.from({ length: 10000 }, (_, i) => ({ get top() { reads++; return i * 1000 }, height: 1000 }))
    expect(positionFromScroll(9876500, pages)).toEqual({ page: 9877, fraction: 0.5 })
    expect(reads).toBeLessThan(30)
  })
})
