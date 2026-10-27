export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>
export const shortcutGroups = [
  { name: '文件与帮助', items: [
    { action: 'open', label: '打开论文', keys: 'Ctrl+O' },
    { action: 'import', label: '导入对照论文', keys: 'Ctrl+Shift+O' },
    { action: 'settings', label: 'API 设置', keys: 'Ctrl+,' },
    { action: 'help', label: '快捷键速查', keys: 'F1' },
    { action: 'escape', label: '取消选区 / 关闭侧栏或弹窗', keys: 'Esc' },
  ] },
  { name: '阅读', items: [
    { action: 'page', label: '跳转到页码', keys: 'Ctrl+G' },
    { action: 'previous', label: '上一页', keys: 'Ctrl+PageUp' },
    { action: 'next', label: '下一页', keys: 'Ctrl+PageDown' },
    { action: 'zoomIn', label: '放大', keys: 'Ctrl++' },
    { action: 'zoomOut', label: '缩小', keys: 'Ctrl+−' },
    { action: 'zoomReset', label: '适应宽度', keys: 'Ctrl+0' },
    { action: 'original', label: '单栏左侧', keys: 'Alt+1' },
    { action: 'parallel', label: '双栏对照', keys: 'Alt+2' },
    { action: 'translated', label: '单栏右侧', keys: 'Alt+3' },
    { action: 'link', label: '切换联动阅读', keys: 'Alt+L' },
  ] },
  { name: '批注与提问', items: [
    { action: 'highlight', label: '将选中文字标为黄色高亮', keys: 'Alt+H' },
    { action: 'note', label: '为选中文字添加备注', keys: 'Alt+N' },
    { action: 'annotations', label: '打开 / 关闭批注侧栏', keys: 'Alt+A' },
    { action: 'questions', label: '询问选中文字 / 打开或关闭问答', keys: 'Alt+Q' },
    { action: 'undo', label: '撤销最近一次批注操作', keys: 'Ctrl+Z' },
  ] },
] as const
export type ReaderShortcut = typeof shortcutGroups[number]['items'][number]['action']
const primaryActions: Partial<Record<string, ReaderShortcut>> = { o: 'open', g: 'page', ',': 'settings', pageup: 'previous', pagedown: 'next', '-': 'zoomOut', '0': 'zoomReset', z: 'undo' }
const altActions: Partial<Record<string, ReaderShortcut>> = { '1': 'original', '2': 'parallel', '3': 'translated', l: 'link', a: 'annotations', q: 'questions', h: 'highlight', n: 'note' }
export function shortcutHint(action: ReaderShortcut) {
  const item = shortcutGroups.flatMap(group => [...group.items]).find(item => item.action === action)!
  return `${item.label}（${item.keys}）`
}
export function readerShortcut(event: ShortcutKey): ReaderShortcut | null {
  if (event.isComposing || (event.ctrlKey && event.metaKey)) return null
  const primary = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  let action: ReaderShortcut | null = null
  if (primary && !event.altKey) {
    if (key === '+' || (key === '=' && !event.shiftKey)) action = 'zoomIn'
    else if (key === 'o' && event.shiftKey) action = 'import'
    else if (!event.shiftKey) action = primaryActions[key] ?? null
  } else if (event.altKey && !primary && !event.shiftKey) {
    action = altActions[key] ?? null
  } else if (!primary && !event.altKey && !event.shiftKey) {
    if (key === 'f1') action = 'help'
    else if (key === 'escape') action = 'escape'
  }
  return event.repeat && action !== 'zoomIn' && action !== 'zoomOut' ? null : action
}

export function isShortcutEditingTarget(target: EventTarget | null) {
  return Boolean((target as Element | null)?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))
}
