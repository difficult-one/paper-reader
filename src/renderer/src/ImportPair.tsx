import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, FileText, FolderOpen, LoaderCircle, PanelsLeftRight, X } from 'lucide-react'
import type { PdfChoice } from '../../shared/types'

interface Props { paths: string[]; close(): void; open(original: string, translated: string): Promise<void> }
export function ImportPair({ paths, close, open }: Props) {
  const [files, setFiles] = useState<(PdfChoice | null)[]>([null, null])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('[data-first-focus]')?.focus()
    return () => previous?.focus()
  }, [])
  useEffect(() => {
    if (busy) dialog.current?.focus()
    else if (!dialog.current?.contains(document.activeElement) || document.activeElement === dialog.current) dialog.current?.querySelector<HTMLButtonElement>('[data-first-focus]')?.focus()
  }, [busy])
  useEffect(() => {
    if (!paths.length) return
    let active = true; setBusy(true); setError('')
    void Promise.all(paths.map(path => window.reader.selectPdf(path))).then(results => {
      if (!active) return
      const failure = results.find(result => !result.ok)
      if (failure && !failure.ok) { setError(failure.error); return }
      const next = results.map(result => result.ok ? result.value : null)
      setFiles([next[0] ?? null, next[1] ?? null])
    }).catch(error => { if (active) setError(String(error)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [paths])
  const choose = async (side: number) => {
    setBusy(true); setError('')
    try {
      const result = await window.reader.selectPdf()
      if (!result.ok) throw new Error(result.error)
      if (result.value) setFiles(previous => previous.map((file, index) => index === side ? result.value : file))
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const submit = async () => {
    if (!files[0] || !files[1]) return
    setBusy(true); setError('')
    try { await open(files[0].path, files[1].path) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); close() }
    if (event.key === 'Tab') {
      if (busy) { event.preventDefault(); return }
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0]; const last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }}>
    <section ref={dialog} tabIndex={-1} className="settings-modal pair-modal" role="dialog" aria-modal="true" aria-labelledby="pair-heading" aria-describedby="pair-description">
      <header className="modal-header"><div className="modal-icon"><PanelsLeftRight size={21} /></div><div><h2 id="pair-heading">导入对照论文</h2><p id="pair-description">选择任意两份 PDF，左右对照阅读</p></div><button className="icon-button" aria-label="关闭导入" onClick={close} disabled={busy}><X size={20} /></button></header>
      <div className="pair-body">
        <p className="pair-intro">确认两侧文件，支持任意语言组合。阅读与批注均保存在本机，无需配置 API。</p>
        {files.map((file, side) => <div className="pair-file" key={side}>
          <div className="pair-file-label"><span className="language-tag">{side === 0 ? '左' : '右'}</span><strong>{side === 0 ? '左侧论文' : '右侧论文'}</strong></div>
          <div className="pair-file-content"><FileText size={22} /><div>{file ? <><strong title={file.path}>{file.name}</strong><small title={file.path}>{file.pages} 页 · {file.path}</small></> : <span>选择{side === 0 ? '左侧' : '右侧'} PDF</span>}</div><button data-first-focus={side === 0 ? true : undefined} className="button secondary small" aria-label={side === 0 ? '选择左侧 PDF' : '选择右侧 PDF'} disabled={busy} onClick={() => void choose(side)}><FolderOpen size={15} />{file ? '更换' : '选择文件'}</button></div>
        </div>)}
        <div className="pair-options"><button className="button quiet small" disabled={busy || (!files[0] && !files[1])} aria-label="交换左右文件" onClick={() => { setFiles(([left, right]) => [right, left]); setError('') }}><ArrowLeftRight size={15} />交换左右</button><span>也可同时拖入两份 PDF</span></div>
        {files[0] && files[1] && files[0].pages !== files[1].pages && <p className="pair-page-hint">两份文件页数不同，将分别阅读。你仍可独立翻页、缩放和批注。</p>}
        {error && <div className="form-message failure" role="alert">{error}</div>}
      </div>
      <footer className="modal-footer"><button className="button secondary" onClick={close} disabled={busy}>取消</button><button className="button primary" onClick={() => void submit()} disabled={busy || !files[0] || !files[1]}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? '正在读取…' : '开始对照阅读'}</button></footer>
    </section>
  </div>
}
