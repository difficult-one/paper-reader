import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import type { QuestionConversation, QuestionUsage } from '../shared/types'
import { readJson, writeJson } from './store'
import { sumQuestionUsage, usageFromProvider } from './provider-transport'

export class QuestionHistory {
  private writes: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {}
  private path(id: string) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('文档标识无效。')
    return join(this.directory, 'questions', `${id}.json`)
  }
  private write<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writes.catch(() => {}).then(action); this.writes = operation; return operation
  }
  async list(id: string): Promise<QuestionConversation[]> {
    const path = this.path(id); await this.writes.catch(() => {})
    const history = await readJson<QuestionConversation[]>(path, [])
    if (!Array.isArray(history) || history.some(c => !c || c.documentId !== id || typeof c.id !== 'string' || typeof c.sourceVersion !== 'string' || !c.selectionSnapshot?.anchors?.length || typeof c.selectionSnapshot.quote !== 'string' || !Array.isArray(c.turns))) throw new Error('本地问答记录格式无效，原记录未被覆盖。请在数据目录检查此论文的问答记录。')
    return history
  }
  save(conversation: QuestionConversation) {
    const value = structuredClone(conversation); const path = this.path(value.documentId)
    return this.write(async () => {
      const history = await readJson<QuestionConversation[]>(path, [])
      const index = history.findIndex(item => item.id === value.id)
      if (index >= 0) history[index] = value; else history.unshift(value)
      await writeJson(path, history)
    })
  }
  remove(id: string, conversationId?: string) {
    const path = this.path(id)
    return this.write(async () => {
      const history = await readJson<QuestionConversation[]>(path, [])
      await writeJson(path, conversationId ? history.filter(item => item.id !== conversationId) : [])
    })
  }
  recordUsage(documentId: string, requestId: string, usage: QuestionUsage) {
    return this.write(async () => {
      const path = join(this.directory, 'question-usage.json')
      const ledger = await readJson(path, { total: usageFromProvider(undefined, false), receipts: [] as string[] })
      const receipt = `${documentId}:${requestId}`
      if (ledger.receipts.includes(receipt) || ledger.receipts.includes(requestId)) return
      ledger.total = sumQuestionUsage([ledger.total, usage]); ledger.receipts.push(receipt)
      await writeJson(path, ledger)
    })
  }
  async usage(): Promise<QuestionUsage> {
    await this.writes.catch(() => {})
    return (await readJson(join(this.directory, 'question-usage.json'), { total: usageFromProvider(undefined, false) })).total
  }
  async recover() {
    const names = await readdir(join(this.directory, 'questions')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try { for (const conversation of await this.list(name.slice(0, -5))) {
        let changed = false
        for (const turn of conversation.turns) if (turn.status === 'indexing' || turn.status === 'sending') {
          turn.status = 'failed'; turn.error = '上次问答因应用关闭而中断。已保留部分内容，请手动重试。'; turn.finishedAt = Date.now()
          // An interrupted network request may have been charged without reporting usage.
          if (turn.usage.requests) turn.usage.unknownRequests = Math.max(1, turn.usage.unknownRequests)
          await this.recordUsage(conversation.documentId, turn.requestId, turn.usage).catch(() => { turn.warning = '用量记录未能保存，用量统计可能不完整。' }); changed = true
        }
        if (changed) await this.save(conversation)
      } } catch { /* Leave damaged records intact; accessing that document surfaces its own error. */ }
    }
  }
  async flush() { await this.writes }
}
