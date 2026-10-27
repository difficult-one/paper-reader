import { useEffect, useRef } from 'react'
import { Keyboard, X } from 'lucide-react'
import { shortcutGroups } from './reader-shortcuts'

export function ShortcutsHelp({ close }: { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    return () => { element.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} className="shortcuts-modal" aria-labelledby="shortcuts-heading" aria-describedby="shortcuts-description" onCancel={event => { event.preventDefault(); close() }} onClick={event => {
    if (event.target !== event.currentTarget) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close()
  }}>
    <header className="modal-header"><div className="modal-icon"><Keyboard size={21} /></div><div><h2 id="shortcuts-heading">快捷键</h2><p id="shortcuts-description">常用操作，抬手就能完成</p></div><button autoFocus className="icon-button" aria-label="关闭快捷键" onClick={close}><X size={20} /></button></header>
    <div className="shortcuts-body">{shortcutGroups.map(group => <section className="shortcut-group" key={group.name}><h3>{group.name}</h3><dl className="shortcut-list">{group.items.map(item => <div key={item.action}><dt>{item.label}</dt><dd><kbd>{item.keys}</kbd></dd></div>)}</dl></section>)}
      <p className="shortcuts-note">跳页和缩放作用于最近操作的阅读栏，开启联动时两栏一起变化。Ctrl+0 为适应宽度。输入文字时保留文字编辑快捷键；Ctrl+Z 在阅读区撤销批注，在输入框撤销文字。</p>
    </div>
  </dialog>
}
