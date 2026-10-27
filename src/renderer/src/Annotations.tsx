import { useLayoutEffect, useRef } from 'react'
import { Highlighter, MessageSquarePlus, NotebookPen, Search, Trash2, X } from 'lucide-react'
import type { HighlightColor, PaperAnnotation } from '../../shared/types'
import { colorNames, highlightColors } from '../../shared/selection'
import { shortcutHint } from './reader-shortcuts'
const colors = Object.keys(highlightColors) as HighlightColor[]
export function SelectionToolbar({ x, y, save, ask, close }: { x: number; y: number; save(color: HighlightColor, note: boolean): void; ask(): void; close(): void }) {
  const toolbar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = toolbar.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(12, Math.min(x, window.innerWidth - bounds.width - 12))}px`
    element.style.top = `${Math.max(12, Math.min(y, window.innerHeight - bounds.height - 12))}px`
  }, [x, y])
  return <div ref={toolbar} className="selection-toolbar" data-testid="selection-toolbar" style={{ left: x, top: y }} onMouseDown={event => event.preventDefault()}>
    <button className="button small primary selection-ask" aria-label="询问选中文字" title="询问选中文字（Alt+Q）" onClick={ask}><Search size={15} />询问</button><span className="toolbar-separator" />
    <Highlighter size={15} />{colors.map(color => <button key={color} className="color-dot" aria-label={`${colorNames[color]}高亮`} title={color === 'yellow' ? shortcutHint('highlight') : `${colorNames[color]}高亮`} style={{ backgroundColor: highlightColors[color] }} onClick={() => save(color, false)} />)}
    <span className="toolbar-separator" /><button className="text-button" title={shortcutHint('note')} onClick={() => save('yellow', true)}><MessageSquarePlus size={15} />添加备注</button><button className="icon-button" aria-label="取消选中" title="取消选中（Esc）" onClick={close}><X size={13} /></button>
  </div>
}
interface Props { annotations: PaperAnnotation[]; selectedId: string | null; saving: boolean; select(annotation: PaperAnnotation): void; edit(annotation: PaperAnnotation, note: string, color: HighlightColor): void; remove(annotation: PaperAnnotation): void; close(): void }
export function AnnotationPanel({ annotations, selectedId, saving, select, edit, remove, close }: Props) {
  return <aside className="annotation-panel" aria-label="批注侧栏">
    <header><NotebookPen size={17} /><strong>我的批注</strong><span className="annotation-count">{annotations.length}</span><button className="icon-button" aria-label="关闭批注侧栏" onClick={close}><X size={17} /></button></header>
    <div className="annotation-save-state">{saving ? '正在保存…' : '批注自动保存在本机'}</div>
    <div className="annotation-list">{!annotations.length ? <div className="annotation-empty"><Highlighter size={27} strokeWidth={1.4} /><p>选中论文中的文字，<br />为重点高亮，给想法留白。</p><small>左右两侧的论文都可以批注</small></div> : annotations.map(annotation => <article key={annotation.id} className={`annotation-card ${selectedId === annotation.id ? 'selected' : ''}`}>
      <button className="annotation-jump" onClick={() => select(annotation)}><span className="annotation-meta"><i style={{ background: highlightColors[annotation.color] }} />{annotation.sourceKey === 'original' ? '左侧' : '右侧'} · 第 {annotation.anchors[0].page} 页</span><blockquote>{annotation.quote}</blockquote></button>
      {(selectedId === annotation.id || annotation.note) && <textarea aria-label="批注备注" placeholder="写下你的理解、疑问或想法…" value={annotation.note} rows={3} maxLength={12000} onFocus={() => { if (selectedId !== annotation.id) select(annotation) }} onChange={event => edit(annotation, event.target.value, annotation.color)} />}
      {selectedId === annotation.id && <div className="annotation-edit-actions"><div>{colors.map(color => <button key={color} className={`color-dot ${color === annotation.color ? 'active' : ''}`} style={{ background: highlightColors[color] }} aria-label={`将批注改为${colorNames[color]}`} onClick={() => edit(annotation, annotation.note, color)} />)}</div><button className="icon-button" aria-label="删除批注" onClick={() => remove(annotation)}><Trash2 size={14} /></button></div>}
    </article>)}</div>
  </aside>
}
