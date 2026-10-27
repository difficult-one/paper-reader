import { Fragment, useEffect, useRef, useState } from 'react'
import { Copy, LoaderCircle, MessageCircleQuestion, NotebookPen, Send, Square, Trash2, X } from 'lucide-react'
import type { DocumentSession, PublicSettings, QuestionConversation, QuestionEvidence, QuestionTurn, QuestionUsage, SelectionSnapshot } from '../../shared/types'

export interface QuestionSelection { sourceVersion: string; snapshot: SelectionSnapshot }
interface Props {
  doc: DocumentSession; settings: PublicSettings | null; visible: boolean; selection: QuestionSelection | null;
  close(): void; configure(): void; cite(evidence: QuestionEvidence): void; save(conversation: QuestionConversation, turn: QuestionTurn): Promise<void>;
}
const activeTurn = (turn: QuestionTurn) => turn.status === 'indexing' || turn.status === 'sending'
const versionLabel = (version: string) => version === 'original' ? '左侧论文' : '右侧论文'
function Answer({ turn, cite }: { turn: QuestionTurn; cite(evidence: QuestionEvidence): void }) {
  const pieces = turn.answer.split(/(\[S\d+\])/g)
  return <div className="question-answer">{pieces.map((piece, index) => {
    const id = piece.match(/^\[(S\d+)\]$/)?.[1]
    const evidence = id && !activeTurn(turn) && turn.citationIds.includes(id) ? turn.evidence.find(e => e.id === id) : undefined
    return evidence ? <button className="citation-link" data-citation={id} key={index} title={evidence.text} onClick={() => cite(evidence)}>{versionLabel(evidence.sourceVersion)}第 {evidence.page} 页</button> : <Fragment key={index}>{piece}</Fragment>
  })}</div>
}
export function QuestionPanel({ doc, settings, visible, selection, close, configure, cite, save }: Props) {
  const [history, setHistory] = useState<QuestionConversation[]>([])
  const [conversation, setConversation] = useState<QuestionConversation | null>(null)
  const [frozen, setFrozen] = useState<QuestionSelection | null>(selection)
  const [question, setQuestion] = useState('')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [usage, setUsage] = useState<QuestionUsage | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const pending = useRef<{ requestId: string; sequence: number; question: string; stopping?: boolean } | null>(null)
  const mounted = useRef(true)
  const conversationRef = useRef(conversation); conversationRef.current = conversation
  const input = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const refreshUsage = () => { void window.reader.questionUsage().then(result => { if (mounted.current && result.ok) setUsage(result.value) }) }
  const updateHistory = (next: QuestionConversation) => {
    setHistory(previous => previous.some(c => c.id === next.id && c.updatedAt > next.updatedAt) ? previous : [next, ...previous.filter(item => item.id !== next.id)].sort((a, b) => b.updatedAt - a.updatedAt))
  }
  const merge = (next: QuestionConversation) => {
    updateHistory(next)
    setConversation(next); conversationRef.current = next
  }
  useEffect(() => {
    mounted.current = true
    void window.reader.questionHistory(doc.id).then(result => {
      if (!mounted.current) return
      setLoading(false)
      if (result.ok) setHistory(previous => [...previous, ...result.value.filter(c => !previous.some(p => p.id === c.id))])
      else setError(result.error)
    })
    refreshUsage()
    const unsubscribe = window.reader.onQuestion(event => {
      if (event.documentId !== doc.id) return
      const terminal = ['completed', 'failed', 'cancelled'].includes(event.type)
      if (terminal && event.conversation) {
        updateHistory(event.conversation); refreshUsage()
        if (!pending.current && conversationRef.current?.id === event.conversation.id && event.conversation.updatedAt >= conversationRef.current.updatedAt) { setConversation(event.conversation); conversationRef.current = event.conversation }
      }
      const current = pending.current
      if (!current || event.requestId !== current.requestId || event.sequence <= current.sequence) return
      current.sequence = event.sequence
      if (event.conversation) merge(event.conversation)
      if (event.type === 'delta' && event.delta) {
        setConversation(previous => previous ? { ...previous, turns: previous.turns.map(turn => turn.requestId === event.requestId ? { ...turn, answer: turn.answer + event.delta } : turn) } : previous)
      }
      if (terminal) { pending.current = null; setSending(false) }
    })
    return () => {
      mounted.current = false; unsubscribe()
      const current = pending.current; pending.current = null
      if (current) void window.reader.cancelQuestion(doc.id, current.requestId)
    }
  }, [doc.id])
  useEffect(() => {
    if (!selection) return
    const current = pending.current; pending.current = null
    if (current) void window.reader.cancelQuestion(doc.id, current.requestId)
    setFrozen(structuredClone(selection)); setConversation(null); conversationRef.current = null
    setSending(false); setQuestion(''); setError(''); setFeedback(''); followBottom.current = true
  }, [selection])
  useEffect(() => { if (visible) input.current?.focus({ preventScroll: true }) }, [visible, selection])
  useEffect(() => { if (list.current && followBottom.current) list.current.scrollTop = list.current.scrollHeight }, [conversation])
  const send = async (text: string) => {
    if (pending.current || sending || !text.trim()) return
    if (!frozen) { setError('请先选中论文文字，再点击选区旁的“询问”。'); return }
    if (frozen.snapshot.quote.length > 2000) { setError('选区超过 2,000 字符，请缩小范围或分段提问。'); return }
    if (!settings?.hasApiKey || !settings.model) { setQuestion(text); configure(); return }
    const current = conversationRef.current
    const requestId = crypto.randomUUID()
    pending.current = { requestId, sequence: 0, question: text }; setSending(true); setError(''); setFeedback(''); setQuestion(''); followBottom.current = true
    try {
      const result = await window.reader.startQuestion({ requestId, documentId: doc.id, sourceVersion: frozen.sourceVersion, selectionSnapshot: structuredClone(frozen.snapshot), question: text.trim(), conversationId: current?.id, disclosureAccepted: true })
      if (!mounted.current || pending.current?.requestId !== requestId) return
      if (result.ok) { if (!pending.current.sequence) merge(result.value) }
      else {
        const stopped = pending.current.stopping
        pending.current = null; setSending(false); setQuestion(text)
        if (stopped) setFeedback('已停止生成'); else setError(result.error)
      }
    } catch (e) { if (mounted.current && pending.current?.requestId === requestId) { pending.current = null; setSending(false); setQuestion(text); setError(String(e)) } }
  }
  const stop = async () => {
    const current = pending.current
    if (!current) return
    current.stopping = true
    const result = await window.reader.cancelQuestion(doc.id, current.requestId)
    if (mounted.current && !result.ok) setError(result.error)
    if (mounted.current && pending.current === current && result.ok) {
      const history = await window.reader.questionHistory(doc.id)
      if (!mounted.current || pending.current !== current) return
      const completed = history.ok ? history.value.find(c => c.turns.some(t => t.requestId === current.requestId)) : undefined
      if (completed) merge(completed); else setQuestion(current.question)
      pending.current = null; setSending(false); setFeedback('已停止生成')
    }
  }
  const choose = (id: string) => {
    const next = history.find(item => item.id === id) ?? null
    setConversation(next); conversationRef.current = next
    if (next) setFrozen({ sourceVersion: next.sourceVersion, snapshot: structuredClone(next.selectionSnapshot) })
    else setFrozen(selection ? structuredClone(selection) : null)
    setError(''); setFeedback(''); setQuestion(''); followBottom.current = true
  }
  const remove = async () => {
    if (!conversation || sending) return
    const id = conversation.id
    const result = await window.reader.deleteQuestionHistory(doc.id, id)
    if (!mounted.current) return
    if (!result.ok) setError(result.error)
    else { setHistory(previous => previous.filter(c => c.id !== id)); choose(''); setFeedback('已删除此会话，论文和批注已保留') }
  }
  const saveTurn = async (turn: QuestionTurn) => {
    if (!conversation || saving) return
    setSaving(turn.requestId); setError('')
    try { await save(conversation, turn); if (mounted.current) setFeedback('已保存为新备注') }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setSaving(null) }
  }
  const currentTurn = conversation?.turns.at(-1)
  const status = sending ? currentTurn?.status === 'sending' ? '正在生成回答…' : '正在构建论文索引…' : currentTurn?.status === 'failed' ? '回答未完成' : currentTurn?.status === 'cancelled' ? '已停止生成' : currentTurn ? '回答已完成' : ''
  const outdated = Boolean(frozen && frozen.sourceVersion !== 'original' && frozen.sourceVersion !== `translated:${doc.translationKey}`)
  return <aside className="question-panel" aria-label="论文问答侧栏" hidden={!visible} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <header><MessageCircleQuestion size={18} /><strong>论文问答</strong><button className="icon-button" aria-label="关闭问答侧栏" onClick={close}><X size={17} /></button></header>
    <div className="question-messages" ref={list} onScroll={() => { const el = list.current; if (el) followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
    <div className="question-history"><select aria-label="问答会话" value={conversation?.id ?? ''} disabled={sending || loading} onChange={event => choose(event.target.value)}><option value="">{loading ? '正在读取本机会话…' : '新的选区问题'}</option>{history.map(c => <option key={c.id} value={c.id}>{versionLabel(c.sourceVersion)} · 第 {c.selectionSnapshot.anchors[0].page} 页 · {c.selectionSnapshot.quote.slice(0, 30)}</option>)}</select><button className="icon-button" aria-label="删除当前问答会话" disabled={!conversation || sending} onClick={() => void remove()}><Trash2 size={15} /></button></div>
    {frozen ? <div className="question-selection"><span>{versionLabel(frozen.sourceVersion)} · 第 {frozen.snapshot.anchors.map(a => a.page).join('、')} 页{frozen.sourceVersion !== 'original' && ' · 依据右侧论文'}</span><blockquote>{frozen.snapshot.quote}</blockquote>{frozen.snapshot.quote.length > 2000 && <p className="question-error">选区超过 2,000 字符，请缩小范围或分段提问。</p>}</div> : <div className="question-empty"><MessageCircleQuestion size={25} /><p>{doc.hasText ? '选中论文中的词、句子或段落，点击选区旁的放大镜“询问”。' : '此 PDF 没有可选中的正文。请先进行 OCR 文字识别后提问。'}</p><small>论文内问答优先；证据不足会明确说明。</small></div>}
      {conversation?.turns.map(turn => <article className="question-turn" key={turn.requestId}><h3>{turn.question}</h3>
        {turn.answer ? <Answer turn={turn} cite={cite} /> : activeTurn(turn) ? <p className="question-pending"><LoaderCircle size={14} className="spin" />{turn.status === 'indexing' ? '正在检索论文片段…' : '正在等待服务返回…'}</p> : null}
        {turn.warning && <p className="question-warning">{turn.warning}</p>}{turn.error && <p className="question-error">{turn.error}</p>}
        {!activeTurn(turn) && <><div className="question-turn-actions">{turn.answer && <><button className="text-button" onClick={() => void window.reader.copyText(turn.answer).then(result => { if (result.ok) setFeedback('已复制回答'); else setError(result.error) }, () => setError('无法复制，请选中文字手动复制。'))}><Copy size={13} />复制回答</button><button className="text-button" disabled={saving !== null || outdated} onClick={() => void saveTurn(turn)}><NotebookPen size={13} />{saving === turn.requestId ? '正在保存…' : '保存为备注'}</button></>}{(turn.status === 'failed' || turn.status === 'cancelled') && <button className="text-button" aria-label="重试此问题" disabled={sending || outdated} onClick={() => void send(turn.question)}>重试</button>}</div>
          {turn.citationIds.length > 0 && <details className="question-evidence"><summary>核对证据片段（{turn.citationIds.length}）</summary>{turn.evidence.filter(e => turn.citationIds.includes(e.id)).map(e => <div key={e.id}><button className="text-button" disabled={outdated} onClick={() => cite(e)}>{versionLabel(e.sourceVersion)}第 {e.page} 页</button><p>{e.text}</p></div>)}</details>}
          <div className="question-turn-meta">{turn.usage.localCacheHits ? '本地复用 · 未调用服务' : turn.usage.requests ? `${turn.usage.usageReported ? `输入 ${turn.usage.promptTokens} · 输出 ${turn.usage.completionTokens} token` : '服务未报告完整用量，可能已计费'}${turn.firstTokenMs !== undefined ? ` · 首字 ${(turn.firstTokenMs / 1000).toFixed(1)} 秒` : ''}` : '本地证据检查 · 未调用服务'}</div></>}
      </article>)}
    </div>
    <div className="question-composer">
      {outdated && <p className="question-error">此会话的右侧论文已更换。可回看内容，请重新选字开始提问。</p>}
      <div className="question-quick-actions">{['解释术语', '解释这句话', '在本文中有什么作用'].map(text => <button key={text} className="button small secondary" disabled={!frozen || sending || outdated} onClick={() => void send(text)}>{text}</button>)}</div>
      <p className="question-disclosure">发送时，选区及相关论文片段会发送至{settings?.model ? `已配置服务（${settings.model}）` : '已配置服务'}。不上传整篇，不自动联网检索。</p>
      {(!settings?.hasApiKey || !settings.model) && <button className="text-button" onClick={configure}>配置问答使用的服务和模型</button>}
      <form onSubmit={event => { event.preventDefault(); void send(question) }}><textarea ref={input} aria-label="追问或输入问题" placeholder={frozen ? '追问或输入你的问题…' : '先选中论文文字'} value={question} disabled={outdated} maxLength={2000} rows={2} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(question) } }} />
        <div className="question-send-row"><span>Enter 发送 · Shift+Enter 换行</span>{sending ? <button className="button small secondary" aria-label="停止生成" type="button" onClick={() => void stop()}><Square size={13} />停止</button> : <button className="button small primary" type="submit" disabled={!frozen || !question.trim() || outdated}><Send size={13} />发送</button>}</div>
      </form>
      {error && <p role="alert" className="question-error">{error}</p>}
      <p className="question-live" role="status" aria-live="polite">{feedback || status || '会话仅保存在本机'}</p>
      {usage && usage.requests > 0 && <div className="question-usage" aria-label="问答用量统计">问答累计：输入 {usage.promptTokens.toLocaleString()} · 输出 {usage.completionTokens.toLocaleString()} token{usage.unknownRequests > 0 && ` · ${usage.unknownRequests} 次用量未知`}</div>}
    </div>
  </aside>
}
