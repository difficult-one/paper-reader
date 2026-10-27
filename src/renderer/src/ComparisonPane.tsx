import { useState, type ReactNode } from 'react'
import { Upload } from 'lucide-react'

export const paperDragType = 'application/x-paper-reader-document'
export type PaperDrop = { file: File } | { documentId: string }
interface Props { side: 'left' | 'right'; enabled: boolean; children: ReactNode; drop(source: PaperDrop): void; clearGlobal(): void }

export function ComparisonPane({ side, enabled, children, drop, clearGlobal }: Props) {
  const [over, setOver] = useState(false)
  return <div className="comparison-pane" data-drop-side={side} onDragOver={event => {
    if (!enabled || (!event.dataTransfer.types.includes(paperDragType) && !(event.dataTransfer.types.includes('Files') && event.dataTransfer.items.length === 1))) { setOver(false); return }
    event.preventDefault(); event.stopPropagation(); clearGlobal(); setOver(true)
    event.dataTransfer.dropEffect = 'copy'
  }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false) }} onDragEnd={() => setOver(false)} onDrop={event => {
    setOver(false)
    if (!enabled) return
    const id = event.dataTransfer.getData(paperDragType)
    if (!id && event.dataTransfer.files.length !== 1) return
    event.preventDefault(); event.stopPropagation(); clearGlobal()
    drop(id ? { documentId: id } : { file: event.dataTransfer.files[0] })
  }}>
    {children}
    {over && enabled && <div className="pane-drop-overlay"><Upload size={34} /><strong>松开以放到{side === 'left' ? '左侧' : '右侧'}</strong><span>支持任意语言的 PDF 论文</span></div>}
  </div>
}
