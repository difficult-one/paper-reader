import { ChevronsLeft, FileText, Plus, X } from 'lucide-react'
import type { DocumentSession } from '../../shared/types'
import { paperDragType } from './ComparisonPane'

interface Props {
  documents: DocumentSession[]; activeId?: string; open: boolean; busy: boolean;
  select(id: string): void; remove(id: string): void; add(): void; close(): void;
}

export function DocumentList({ documents, activeId, open, busy, select, remove, add, close }: Props) {
  return <aside className="document-list" id="document-list" aria-label="已打开的论文" hidden={!open}>
    <header><strong>已打开的论文</strong><span className="mini-count">{documents.length}</span><button className="icon-button" aria-label="收起论文列表" onClick={close}><ChevronsLeft size={17} /></button></header>
    <ul className="document-list-items">{documents.map(doc => {
      const active = doc.id === activeId
      const mode = doc.reading?.mode
      const position = mode === 'translated' ? doc.reading?.right : doc.reading?.left
      const pages = mode === 'translated' ? doc.translatedPages ?? doc.pages : doc.pages
      return <li key={doc.id} className={`document-list-item ${active ? 'active' : ''}`}>
        <button className="document-list-select" aria-label={`切换到论文：${doc.name}`} aria-current={active ? 'true' : undefined} title={`${doc.path}\n可拖到左侧或右侧对照`} draggable={!busy} onDragStart={event => { event.dataTransfer.setData(paperDragType, doc.id); event.dataTransfer.effectAllowed = 'copy' }} disabled={busy} onClick={() => select(doc.id)}>
          <FileText size={21} strokeWidth={1.6} />
          <span><strong>{doc.name}</strong><small>第 {Math.min(position?.page ?? 1, pages)} / {pages} 页 · {doc.translatedUrl ? '双栏对照' : '单篇阅读'}</small>{active && <span className="document-list-current">正在阅读</span>}</span>
        </button>
        <button className="icon-button document-list-close" aria-label={`关闭论文：${doc.name}`} title="从列表关闭，保留阅读记录和批注" disabled={busy} onClick={() => remove(doc.id)}><X size={14} /></button>
      </li>
    })}</ul>
    {!documents.length && <div className="document-list-empty"><FileText size={27} strokeWidth={1.5} /><p>还没有打开的论文</p><small>打开或拖入 PDF，即可加入列表。</small></div>}
    <footer><button className="button secondary" onClick={add} disabled={busy}><Plus size={16} />添加论文</button><small>继续拖入 PDF，追加到列表</small></footer>
  </aside>
}
