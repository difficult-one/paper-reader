import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronsLeft, ListTree, LoaderCircle } from 'lucide-react'
import type { DocumentSession, Position, ReadMode } from '../../shared/types'
import type { LoadedPdf } from './PdfPane'
import { outlinePosition, type PdfOutlineNode } from './pdf-outline'

interface Props {
  doc: DocumentSession; mode: ReadMode; open: boolean;
  left: LoadedPdf | null; right: LoadedPdf | null;
  navigate(side: 'left' | 'right', position: Position): void; close(): void;
}

export function OutlinePanel({ doc, mode, open, left, right, navigate, close }: Props) {
  const [chosenSide, setChosenSide] = useState<'left' | 'right'>('left')
  const side = mode === 'translated' ? 'right' : mode === 'original' || !doc.translatedUrl ? 'left' : chosenSide
  const loaded = side === 'left' ? left : right
  const url = side === 'left' ? doc.originalUrl : doc.translatedUrl
  const pdf = loaded && loaded.url === url ? loaded.pdf : null
  const [outline, setOutline] = useState<{ pdf: typeof pdf; items: PdfOutlineNode[]; error: boolean } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [locating, setLocating] = useState(false)
  const navigation = useRef(0)
  useEffect(() => {
    navigation.current++; setLocating(false); setMessage(''); setSelected(null); setCollapsed(new Set())
    if (!pdf || !open) return
    let cancelled = false
    setOutline(null)
    void pdf.getOutline().then(items => {
      if (!cancelled) setOutline({ pdf, items: items ?? [], error: false })
    }).catch(() => { if (!cancelled) setOutline({ pdf, items: [], error: true }) })
    return () => { cancelled = true; navigation.current++ }
  }, [pdf, open])
  const jump = async (node: PdfOutlineNode, id: string) => {
    if (!pdf) return
    const request = ++navigation.current
    setLocating(true); setMessage('')
    try {
      const position = await outlinePosition(pdf, node.dest)
      if (request !== navigation.current) return
      if (!position) { setMessage('无法定位这个章节，请选择其他章节或使用页码跳转。'); return }
      setSelected(id); navigate(side, position)
    } catch { if (request === navigation.current) setMessage('无法定位这个章节，请选择其他章节或使用页码跳转。') }
    finally { if (request === navigation.current) setLocating(false) }
  }
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const nodes = (items: PdfOutlineNode[], parent = '', depth = 0): React.ReactNode => <ul>{items.map((item, index) => {
    const id = `${parent}/${index}`; const expanded = !collapsed.has(id)
    return <li key={id}>
      <div className="outline-row" style={{ paddingLeft: 8 + Math.min(depth, 6) * 14 }}>
        {item.items.length > 0 ? <button className="icon-button outline-disclosure" aria-label={`${expanded ? '收起' : '展开'}子章节：${item.title}`} aria-expanded={expanded} aria-controls={`outline-children-${id.replaceAll('/', '-')}`} onClick={() => toggle(id)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="outline-spacer" />}
        <button className="outline-link" aria-current={selected === id ? 'location' : undefined} disabled={!item.dest || locating} onClick={() => void jump(item, id)} title={item.dest ? item.title : '此条目没有可跳转的页面'}>{item.title || '未命名章节'}</button>
      </div>
      {item.items.length > 0 && <div id={`outline-children-${id.replaceAll('/', '-')}`} hidden={!expanded}>{nodes(item.items, id, depth + 1)}</div>}
    </li>
  })}</ul>
  const ready = pdf && outline?.pdf === pdf
  return <aside className="outline-panel" id="chapter-outline" aria-label="章节目录" hidden={!open}>
    <header><ListTree size={17} /><strong>章节目录</strong><button className="icon-button" aria-label="收起章节目录" title="收起目录（Esc）" onClick={close}><ChevronsLeft size={17} /></button></header>
    <div className="outline-source">
      {mode === 'parallel' && doc.translatedUrl ? <select aria-label="目录来源" value={side} onChange={event => setChosenSide(event.target.value as 'left' | 'right')}><option value="left">左侧论文</option><option value="right">右侧论文</option></select> : <span>{side === 'left' ? '左侧论文' : '右侧论文'}</span>}
      <strong title={side === 'left' ? doc.name : doc.translatedName}>{side === 'left' ? doc.name : doc.translatedName ?? '右侧论文.pdf'}</strong>
    </div>
    {!ready ? <div className="outline-empty" role="status"><LoaderCircle className="spin" size={20} /><p>正在载入章节目录…</p></div> : <div className="outline-content">
      {outline.items.length > 0 ? <nav aria-label="章节列表">{nodes(outline.items)}</nav> : <>
        <div className="outline-empty"><ListTree size={23} /><p>{outline.error ? '暂时无法读取章节目录' : '这份 PDF 没有内置章节目录'}</p><small>{outline.error ? '重新打开目录可重试，也可以按页码阅读。' : '可以使用下面的页码直接跳转。'}</small></div>
        <nav className="outline-pages" aria-label="页码导航">{Array.from({ length: pdf.numPages }, (_, index) => <button className="button secondary" key={index} onClick={() => navigate(side, { page: index + 1, fraction: 0 })}>第 {index + 1} 页</button>)}</nav>
      </>}
    </div>}
    <div className="outline-feedback" role="status" aria-live="polite">{locating ? '正在定位章节…' : message}</div>
  </aside>
}
