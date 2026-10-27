import { useEffect, useState } from 'react'
import type { QuestionUsage } from '../../shared/types'

export function QuestionUsageSummary() {
  const [usage, setUsage] = useState<QuestionUsage | null>(null)
  useEffect(() => {
    let active = true
    const refresh = () => { void window.reader.questionUsage().then(result => { if (active && result.ok) setUsage(result.value) }) }
    refresh()
    const unsubscribe = window.reader.onQuestion(event => { if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') refresh() })
    return () => { active = false; unsubscribe() }
  }, [])
  if (!usage || (!usage.requests && !usage.localCacheHits)) return null
  return <div className="job-metrics" aria-label="问答累计用量">
    <span>问答累计：请求 {usage.requests} 次 · 本地复用 {usage.localCacheHits} 次</span>
    <span>输入 {usage.promptTokens.toLocaleString()} · 输出 {usage.completionTokens.toLocaleString()} token</span>
    {usage.unknownRequests > 0 && <span>{usage.unknownRequests} 次问答用量未完整报告，可能已计费</span>}
  </div>
}
